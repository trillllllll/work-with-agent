import { randomUUID } from 'node:crypto';
import { defaultMobileNavigationJson } from '../domain/mobile-navigation.js';
import { prisma } from '../infrastructure/prisma.js';
import { fetchModelCatalog, probeModelWindow, type ModelCatalog, type ModelWindowProbe } from './model-window.js';

export type ModelConfig = { baseUrl: string; apiKey: string; model: string; contextWindow?: number | null };
/** One saved provider config in `model_profiles_json`; the API key stays server-side like the legacy row. */
export type StoredModelProfile = { id: string; name: string; baseUrl: string; apiKey: string; model: string; contextWindow: number | null };
export type PublicModelProfile = { id: string; name: string; baseUrl: string; model: string; contextWindow: number | null; apiKeyConfigured: boolean; apiKeyMasked: string | null };
export type PublicSettings = { baseUrl: string; model: string; contextWindow: number | null; apiKeyConfigured: boolean; apiKeyMasked: string | null; profiles: PublicModelProfile[]; activeProfileId: string };
/** 0 / empty means unknown. Kept within a plausible model-window range. */
export const CONTEXT_WINDOW_MIN = 1024;
export const CONTEXT_WINDOW_MAX = 10_000_000;
const windowOrNull = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= CONTEXT_WINDOW_MIN && value <= CONTEXT_WINDOW_MAX ? value : null;
export type AssistantIdentityModelOverride = { baseUrl?: string; apiKey?: string; model?: string; contextWindow?: number };
function readAssistantIdentityJson(raw: string | null | undefined): Record<string, AssistantIdentityModelOverride> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, AssistantIdentityModelOverride>;
  } catch { return {}; }
}
export interface CredentialStore { read(): Promise<string | null>; write(value: string): Promise<void>; clear(): Promise<void>; }
const now = () => new Date().toISOString();
const badRequest = (message: string) => Object.assign(new Error(message), { status: 400 });

function readModelProfiles(raw: string | null | undefined): StoredModelProfile[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is StoredModelProfile => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const p = item as Partial<StoredModelProfile>;
      return typeof p.id === 'string' && !!p.id && typeof p.name === 'string' && typeof p.baseUrl === 'string' && typeof p.apiKey === 'string' && typeof p.model === 'string';
    }).map((p) => ({ ...p, contextWindow: windowOrNull(p.contextWindow) }));
  } catch { return []; }
}

export class SqliteCredentialStore implements CredentialStore {
  async read() { return (await prisma.appSetting.findUnique({ where: { id: 'default' } }))?.openaiApiKey || null; }
  async write(value: string) { await prisma.appSetting.upsert({ where: { id: 'default' }, create: { mobileNavigationJson: defaultMobileNavigationJson, id: 'default', openaiApiKey: value, createdAt: now(), updatedAt: now() }, update: { openaiApiKey: value, updatedAt: now() } }); }
  async clear() { await prisma.appSetting.updateMany({ where: { id: 'default' }, data: { openaiApiKey: '', updatedAt: now() } }); }
}

export class SettingsService {
  private readonly id = 'default';
  private readonly SEED_PROFILE_ID = 'default';
  constructor(private readonly credentialsStore: CredentialStore = new SqliteCredentialStore()) {}
  private normalizeBaseUrl(value: string) { const baseUrl = value.trim().replace(/\/+$/, ''); try { const parsed = new URL(baseUrl); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); } catch { throw badRequest('接口地址必须是有效的 HTTP(S) URL'); } return baseUrl; }
  private validateModel(value: string) { const model = value.trim(); if (!model || model.length > 200) throw badRequest('模型名称不能为空且不能超过 200 个字符'); return model; }
  private validateKey(value: string) { const apiKey = value.trim(); if (!apiKey || apiKey.length > 1000) throw badRequest('API Key 不能为空且不能超过 1000 个字符'); return apiKey; }
  private mask(apiKey: string) { return apiKey ? `${apiKey.slice(0, Math.min(3, apiKey.length))}...${apiKey.slice(-4)}` : null; }
  async getStored() { return prisma.appSetting.findUnique({ where: { id: this.id } }); }
  async getPublic() {
    const { profiles, activeProfileId } = await this.ensureProfiles();
    const setting = await this.getStored();
    const apiKey = await this.credentialsStore.read();
    return { baseUrl: setting?.openaiBaseUrl ?? '', model: setting?.openaiModel ?? '', contextWindow: windowOrNull(setting?.openaiContextWindow), apiKeyConfigured: Boolean(apiKey), apiKeyMasked: this.mask(apiKey ?? ''), activeProfileId, profiles: profiles.map((profile) => this.toPublicProfile(profile)) } satisfies PublicSettings;
  }
  /** 模型配置：全局一套；非 work 身份可用 app_settings.assistantIdentityJson 覆盖 baseUrl/apiKey/model，空字段回落全局。 */
  async credentials(identityId?: string): Promise<ModelConfig | null> {
    const setting = await this.getStored();
    const apiKey = await this.credentialsStore.read();
    if (!setting?.openaiBaseUrl || !apiKey || !setting.openaiModel) return null;
    const base = { baseUrl: setting.openaiBaseUrl, apiKey, model: setting.openaiModel, contextWindow: windowOrNull(setting.openaiContextWindow) };
    if (!identityId || identityId === 'work') return base;
    const overrides = readAssistantIdentityJson(setting.assistantIdentityJson)[identityId];
    if (!overrides) return base;
    const model = overrides.model?.trim() || base.model;
    // A different model must not inherit the global model's window.
    const contextWindow = windowOrNull(overrides.contextWindow) ?? (model === base.model ? base.contextWindow : null);
    const config = { baseUrl: overrides.baseUrl?.trim() || base.baseUrl, apiKey: overrides.apiKey?.trim() || base.apiKey, model, contextWindow };
    return config.baseUrl && config.apiKey && config.model ? config : base;
  }
  /** Window for the model a given identity actually calls; null when unknown. */
  async contextWindow(identityId?: string) { return (await this.credentials(identityId))?.contextWindow ?? null; }
  /**
   * Reads the window the provider publishes for this model. Draft values from the
   * form win over stored ones, so the window can be read before saving. Falls back
   * to the stored API key, and never writes: the field stays manually editable.
   */
  async probeContextWindow(input: { baseUrl?: string; model?: string; apiKey?: string } = {}): Promise<ModelWindowProbe> {
    const setting = await this.getStored();
    const baseUrl = input.baseUrl?.trim() ? this.normalizeBaseUrl(input.baseUrl) : setting?.openaiBaseUrl ?? '';
    const model = input.model?.trim() || setting?.openaiModel || '';
    const apiKey = input.apiKey?.trim() || await this.credentialsStore.read() || '';
    if (!baseUrl || !model) throw badRequest('请先填写接口地址和模型名称');
    if (!apiKey) throw badRequest('请先填写 API Key');
    return probeModelWindow({ baseUrl, apiKey, model });
  }
  private validateWindow(value: number | null | undefined) { if (value === undefined) return undefined; if (value === null || value === 0) return 0; if (!windowOrNull(value)) throw badRequest(`上下文上限须为 ${CONTEXT_WINDOW_MIN} 到 ${CONTEXT_WINDOW_MAX} 之间的整数，留空表示未知`); return value; }
  private validateProfileName(value: string) { const name = value.trim(); if (!name || name.length > 60) throw badRequest('配置名称不能为空且不能超过 60 个字符'); return name; }
  private newProfileId() { return `p_${randomUUID()}`; }
  private toPublicProfile(profile: StoredModelProfile): PublicModelProfile { return { id: profile.id, name: profile.name, baseUrl: profile.baseUrl, model: profile.model, contextWindow: profile.contextWindow, apiKeyConfigured: Boolean(profile.apiKey), apiKeyMasked: this.mask(profile.apiKey) }; }
  private resolveActiveId(profiles: StoredModelProfile[], activeId: string) { return profiles.some((profile) => profile.id === activeId) ? activeId : profiles[0]?.id ?? ''; }
  private async persistProfiles(profiles: StoredModelProfile[], activeProfileId: string) {
    const data = { modelProfilesJson: JSON.stringify(profiles), activeModelProfileId: activeProfileId, updatedAt: now() };
    await prisma.appSetting.upsert({ where: { id: this.id }, create: { mobileNavigationJson: defaultMobileNavigationJson, id: this.id, createdAt: now(), ...data }, update: data });
  }
  /** 把使用中的档案写回旧 openai_* 列，credentials()/contextWindow() 等既有读方零改动。 */
  private async materializeProfile(profile: StoredModelProfile) {
    await prisma.appSetting.upsert({
      where: { id: this.id },
      create: { mobileNavigationJson: defaultMobileNavigationJson, id: this.id, openaiBaseUrl: profile.baseUrl, openaiApiKey: profile.apiKey, openaiModel: profile.model, openaiContextWindow: profile.contextWindow ?? 0, createdAt: now(), updatedAt: now() },
      update: { openaiBaseUrl: profile.baseUrl, openaiApiKey: profile.apiKey, openaiModel: profile.model, openaiContextWindow: profile.contextWindow ?? 0, updatedAt: now() },
    });
    await this.credentialsStore.write(profile.apiKey);
  }
  /** 旧库只有一行 openai_* 配置：首次读到空 profiles 时收进一条「默认配置」档案。幂等，只发生一次。 */
  private async ensureProfiles(): Promise<{ profiles: StoredModelProfile[]; activeProfileId: string }> {
    const setting = await this.getStored();
    const profiles = readModelProfiles(setting?.modelProfilesJson);
    if (profiles.length || !(setting?.openaiBaseUrl || setting?.openaiModel || setting?.openaiApiKey)) return { profiles, activeProfileId: this.resolveActiveId(profiles, setting?.activeModelProfileId ?? '') };
    const seeded: StoredModelProfile = { id: this.SEED_PROFILE_ID, name: '默认配置', baseUrl: setting?.openaiBaseUrl ?? '', apiKey: (await this.credentialsStore.read()) ?? setting?.openaiApiKey ?? '', model: setting?.openaiModel ?? '', contextWindow: windowOrNull(setting?.openaiContextWindow) };
    await this.persistProfiles([seeded], seeded.id);
    return { profiles: [seeded], activeProfileId: seeded.id };
  }
  private async testOrThrow(testConnection: (config: ModelConfig) => Promise<void>, config: ModelConfig) {
    try { await testConnection(config); } catch (error) {
      if (error && typeof error === 'object' && 'status' in error) throw error;
      throw Object.assign(error instanceof Error ? error : new Error('模型连接测试失败'), { status: 502, code: 'SETTINGS_CONNECTION_FAILED' });
    }
  }
  /** 保存一套配置：先测试后写入；更新时 Key 留空保持原值；首条档案自动成为使用中。 */
  async saveProfile(input: { profileId?: string; name?: string; baseUrl: string; model: string; apiKey?: string; contextWindow?: number | null }, testConnection: (config: ModelConfig) => Promise<void>) {
    const { profiles, activeProfileId } = await this.ensureProfiles();
    const existing = input.profileId ? profiles.find((profile) => profile.id === input.profileId) : undefined;
    if (input.profileId && !existing) throw badRequest('配置不存在或已被删除');
    const name = input.name !== undefined ? this.validateProfileName(input.name) : existing?.name ?? '默认配置';
    // 部分更新（如卡片上只换模型）：缺省字段沿用已存值；新建必须给全。
    const baseUrl = input.baseUrl !== undefined || !existing ? this.normalizeBaseUrl(input.baseUrl ?? '') : existing.baseUrl;
    const model = input.model !== undefined || !existing ? this.validateModel(input.model ?? '') : existing.model;
    const apiKey = input.apiKey?.trim() || existing?.apiKey || '';
    if (!apiKey) throw badRequest('首次配置必须提供 API Key');
    this.validateKey(apiKey);
    const contextWindow = input.contextWindow === undefined ? existing?.contextWindow ?? null : windowOrNull(this.validateWindow(input.contextWindow)) ?? null;
    await this.testOrThrow(testConnection, { baseUrl, apiKey, model });
    const next: StoredModelProfile = { id: existing?.id ?? this.newProfileId(), name, baseUrl, apiKey, model, contextWindow };
    const nextProfiles = existing ? profiles.map((profile) => (profile.id === next.id ? next : profile)) : [...profiles, next];
    const nextActive = nextProfiles.some((profile) => profile.id === activeProfileId) ? activeProfileId : nextProfiles[0].id;
    await this.persistProfiles(nextProfiles, nextActive);
    if (next.id === nextActive) await this.materializeProfile(next);
    return this.getPublic();
  }
  async deleteProfile(profileId: string) {
    const { profiles, activeProfileId } = await this.ensureProfiles();
    if (!profiles.some((profile) => profile.id === profileId)) throw badRequest('配置不存在或已被删除');
    if (profiles.length <= 1) throw badRequest('至少保留一套配置');
    const nextProfiles = profiles.filter((profile) => profile.id !== profileId);
    const nextActive = activeProfileId === profileId ? nextProfiles[0].id : activeProfileId;
    await this.persistProfiles(nextProfiles, nextActive);
    if (activeProfileId === profileId) await this.materializeProfile(nextProfiles[0]);
    return this.getPublic();
  }
  async activateProfile(profileId: string) {
    const { profiles } = await this.ensureProfiles();
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) throw badRequest('配置不存在或已被删除');
    await this.persistProfiles(profiles, profile.id);
    await this.materializeProfile(profile);
    return this.getPublic();
  }
  /** 复制一套配置（连同已存的 Key）；内容没变，不做连接测试。 */
  async copyProfile(profileId: string) {
    const { profiles, activeProfileId } = await this.ensureProfiles();
    const source = profiles.find((profile) => profile.id === profileId);
    if (!source) throw badRequest('配置不存在或已被删除');
    const copy: StoredModelProfile = { ...source, id: this.newProfileId(), name: `${source.name} 副本` };
    const index = profiles.findIndex((profile) => profile.id === profileId);
    await this.persistProfiles([...profiles.slice(0, index + 1), copy, ...profiles.slice(index + 1)], activeProfileId);
    return this.getPublic();
  }
  /** 服务端代理供应商的 GET /models：显式 Key > 指定档案 Key > 使用中档案 Key。 */
  async fetchModelCatalog(input: { baseUrl?: string; apiKey?: string; profileId?: string } = {}): Promise<ModelCatalog> {
    const { profiles, activeProfileId } = await this.ensureProfiles();
    const active = profiles.find((profile) => profile.id === (input.profileId || activeProfileId)) ?? profiles[0];
    const baseUrl = input.baseUrl?.trim() ? this.normalizeBaseUrl(input.baseUrl) : active?.baseUrl ?? '';
    if (!baseUrl) throw badRequest('请先填写接口地址');
    const apiKey = input.apiKey?.trim() || profiles.find((profile) => profile.id === input.profileId)?.apiKey || active?.apiKey || '';
    if (!apiKey) throw badRequest('请先填写 API Key');
    return fetchModelCatalog({ baseUrl, apiKey });
  }
  /** 旧客户端的整份保存：写进「使用中」的档案；全新库则建立默认档案。 */
  async save(input: { baseUrl: string; model: string; apiKey?: string; contextWindow?: number | null }, testConnection: (config: ModelConfig) => Promise<void>) {
    const { profiles, activeProfileId } = await this.ensureProfiles();
    return profiles.length ? this.saveProfile({ profileId: activeProfileId, baseUrl: input.baseUrl, model: input.model, apiKey: input.apiKey, contextWindow: input.contextWindow }, testConnection) : this.saveProfile({ name: '默认配置', ...input }, testConnection);
  }
  async clearApiKey() {
    const { profiles, activeProfileId } = await this.ensureProfiles();
    const active = profiles.find((profile) => profile.id === activeProfileId);
    if (!active) { if (await this.getStored()) await this.credentialsStore.clear(); return this.getPublic(); }
    const cleared = { ...active, apiKey: '' };
    await this.persistProfiles(profiles.map((profile) => (profile.id === cleared.id ? cleared : profile)), activeProfileId);
    await this.materializeProfile(cleared);
    return this.getPublic();
  }
}
