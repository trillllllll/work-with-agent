import { defaultMobileNavigationJson } from '../domain/mobile-navigation.js';
import { prisma } from '../infrastructure/prisma.js';

export type ModelConfig = { baseUrl: string; apiKey: string; model: string };
export type PublicSettings = { baseUrl: string; model: string; apiKeyConfigured: boolean; apiKeyMasked: string | null };
export type AssistantIdentityModelOverride = { baseUrl?: string; apiKey?: string; model?: string };
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

export class SqliteCredentialStore implements CredentialStore {
  async read() { return (await prisma.appSetting.findUnique({ where: { id: 'default' } }))?.openaiApiKey || null; }
  async write(value: string) { await prisma.appSetting.upsert({ where: { id: 'default' }, create: { mobileNavigationJson: defaultMobileNavigationJson, id: 'default', openaiApiKey: value, createdAt: now(), updatedAt: now() }, update: { openaiApiKey: value, updatedAt: now() } }); }
  async clear() { await prisma.appSetting.updateMany({ where: { id: 'default' }, data: { openaiApiKey: '', updatedAt: now() } }); }
}

export class SettingsService {
  private readonly id = 'default';
  constructor(private readonly credentialsStore: CredentialStore = new SqliteCredentialStore()) {}
  private normalizeBaseUrl(value: string) { const baseUrl = value.trim().replace(/\/+$/, ''); try { const parsed = new URL(baseUrl); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); } catch { throw badRequest('接口地址必须是有效的 HTTP(S) URL'); } return baseUrl; }
  private validateModel(value: string) { const model = value.trim(); if (!model || model.length > 200) throw badRequest('模型名称不能为空且不能超过 200 个字符'); return model; }
  private validateKey(value: string) { const apiKey = value.trim(); if (!apiKey || apiKey.length > 1000) throw badRequest('API Key 不能为空且不能超过 1000 个字符'); return apiKey; }
  private mask(apiKey: string) { return apiKey ? `${apiKey.slice(0, Math.min(3, apiKey.length))}...${apiKey.slice(-4)}` : null; }
  async getStored() { return prisma.appSetting.findUnique({ where: { id: this.id } }); }
  async getPublic() { const setting = await this.getStored(); const apiKey = await this.credentialsStore.read(); return { baseUrl: setting?.openaiBaseUrl ?? '', model: setting?.openaiModel ?? '', apiKeyConfigured: Boolean(apiKey), apiKeyMasked: this.mask(apiKey ?? '') } satisfies PublicSettings; }
  /** 模型配置：全局一套；非 work 身份可用 app_settings.assistantIdentityJson 覆盖 baseUrl/apiKey/model，空字段回落全局。 */
  async credentials(identityId?: string): Promise<ModelConfig | null> {
    const setting = await this.getStored();
    const apiKey = await this.credentialsStore.read();
    if (!setting?.openaiBaseUrl || !apiKey || !setting.openaiModel) return null;
    const base = { baseUrl: setting.openaiBaseUrl, apiKey, model: setting.openaiModel };
    if (!identityId || identityId === 'work') return base;
    const overrides = readAssistantIdentityJson(setting.assistantIdentityJson)[identityId];
    if (!overrides) return base;
    const config = { baseUrl: overrides.baseUrl?.trim() || base.baseUrl, apiKey: overrides.apiKey?.trim() || base.apiKey, model: overrides.model?.trim() || base.model };
    return config.baseUrl && config.apiKey && config.model ? config : base;
  }
  async save(input: { baseUrl: string; model: string; apiKey?: string }, testConnection: (config: ModelConfig) => Promise<void>) { const current = await this.getStored(); const baseUrl = this.normalizeBaseUrl(input.baseUrl); const model = this.validateModel(input.model); const apiKey = input.apiKey?.trim() || await this.credentialsStore.read() || current?.openaiApiKey || ''; if (!apiKey) throw badRequest('首次配置必须提供 API Key'); this.validateKey(apiKey); const config = { baseUrl, apiKey, model }; try { await testConnection(config); } catch (error) { if (error && typeof error === 'object' && 'status' in error) throw error; throw Object.assign(error instanceof Error ? error : new Error('模型连接测试失败'), { status: 502, code: 'SETTINGS_CONNECTION_FAILED' }); } const timestamp = now(); await prisma.appSetting.upsert({ where: { id: this.id }, create: { mobileNavigationJson: defaultMobileNavigationJson, id: this.id, openaiBaseUrl: baseUrl, openaiApiKey: apiKey, openaiModel: model, createdAt: timestamp, updatedAt: timestamp }, update: { openaiBaseUrl: baseUrl, openaiApiKey: apiKey, openaiModel: model, updatedAt: timestamp } }); await this.credentialsStore.write(apiKey); return this.getPublic(); }
  async clearApiKey() { if (await this.getStored()) await this.credentialsStore.clear(); return this.getPublic(); }
}
