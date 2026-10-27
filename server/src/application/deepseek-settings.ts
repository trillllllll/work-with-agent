import { defaultMobileNavigationJson } from '../domain/mobile-navigation.js';
import { prisma } from '../infrastructure/prisma.js';

// 联网搜索密钥优先级：DEEPSEEK_API_KEY 环境变量 > app_settings.deepseekApiKey > 复用 DeepSeek 模型配置的 key。
// 永不通过 API 返回明文，只返回尾 4 位掩码和 managedBy 来源。
const envKey = () => process.env.DEEPSEEK_API_KEY?.trim() || '';
const mask = (key: string) => `••••${key.slice(-4)}`;

async function modelFallbackKey(): Promise<string> {
  try {
    const setting = await prisma.appSetting.findUnique({ where: { id: 'default' }, select: { openaiBaseUrl: true, openaiApiKey: true } });
    if (!setting?.openaiApiKey) return '';
    const host = new URL(setting.openaiBaseUrl.trim()).host;
    return host === 'api.deepseek.com' ? setting.openaiApiKey : '';
  } catch { return ''; }
}

export type WebSearchSettings = { provider: 'deepseek'; configured: boolean; keyMasked: string | null; managedBy: 'environment' | 'application' | 'model' };

export async function deepseekKey(): Promise<string> {
  const env = envKey();
  if (env) return env;
  const stored = await prisma.appSetting.findUnique({ where: { id: 'default' }, select: { deepseekApiKey: true } });
  if (stored?.deepseekApiKey) return stored.deepseekApiKey;
  return modelFallbackKey();
}

export async function webSearchSettings(): Promise<WebSearchSettings> {
  const env = envKey();
  if (env) return { provider: 'deepseek', configured: true, keyMasked: mask(env), managedBy: 'environment' };
  const stored = await prisma.appSetting.findUnique({ where: { id: 'default' }, select: { deepseekApiKey: true } });
  if (stored?.deepseekApiKey) return { provider: 'deepseek', configured: true, keyMasked: mask(stored.deepseekApiKey), managedBy: 'application' };
  const model = await modelFallbackKey();
  return { provider: 'deepseek', configured: Boolean(model), keyMasked: model ? mask(model) : null, managedBy: 'model' };
}

export async function saveDeepseekKey(value: string) {
  if (envKey()) throw Object.assign(new Error('联网搜索密钥由环境变量管理，请修改对应配置'), { status: 409 });
  const timestamp = new Date().toISOString();
  await prisma.appSetting.upsert({ where: { id: 'default' }, create: { mobileNavigationJson: defaultMobileNavigationJson, id: 'default', deepseekApiKey: value.trim(), createdAt: timestamp, updatedAt: timestamp }, update: { deepseekApiKey: value.trim(), updatedAt: timestamp } });
  return webSearchSettings();
}
