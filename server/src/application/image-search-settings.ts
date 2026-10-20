import { prisma } from '../infrastructure/prisma.js';
export async function imageSearchKey() { return process.env.BRAVE_IMAGE_SEARCH_KEY?.trim() || (await prisma.appSetting.findUnique({ where: { id: 'default' }, select: { braveImageApiKey: true } }))?.braveImageApiKey || ''; }
export async function imageSearchSettings() {
  const key = await imageSearchKey();
  return { provider: 'brave' as const, configured: Boolean(key), keyMasked: key ? `••••${key.slice(-4)}` : null, managedBy: process.env.BRAVE_IMAGE_SEARCH_KEY?.trim() ? 'environment' as const : 'application' as const };
}
export async function saveImageSearchKey(value: string) {
  if (process.env.BRAVE_IMAGE_SEARCH_KEY?.trim()) throw Object.assign(new Error('图片搜索密钥由环境变量管理，请修改对应配置'), { status: 409 });
  const timestamp = new Date().toISOString();
  await prisma.appSetting.upsert({ where: { id: 'default' }, create: { id: 'default', braveImageApiKey: value.trim(), createdAt: timestamp, updatedAt: timestamp }, update: { braveImageApiKey: value.trim(), updatedAt: timestamp } });
  return imageSearchSettings();
}
