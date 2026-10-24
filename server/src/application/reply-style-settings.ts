import { prisma } from '../infrastructure/prisma.js';
import { defaultMobileNavigationJson } from '../domain/mobile-navigation.js';

export const DEFAULT_REPLY_STYLE = '结论先行，多用短句。';

export async function replyStyleSettings() {
  const row = await prisma.appSetting.findUnique({ where: { id: 'default' }, select: { replyStyle: true } });
  return { replyStyle: row?.replyStyle ?? DEFAULT_REPLY_STYLE, defaultReplyStyle: DEFAULT_REPLY_STYLE };
}

export async function saveReplyStyle(replyStyle: string) {
  const timestamp = new Date().toISOString();
  await prisma.appSetting.upsert({
    where: { id: 'default' },
    create: { id: 'default', mobileNavigationJson: defaultMobileNavigationJson, replyStyle: replyStyle.trim(), createdAt: timestamp, updatedAt: timestamp },
    update: { replyStyle: replyStyle.trim(), updatedAt: timestamp },
  });
  return replyStyleSettings();
}

export function replyStylePrompt(replyStyle: string) {
  return replyStyle ? `【回复风格】\n以下偏好只约束表达方式，不改变事实、权限、审批或系统规定的回复语言。\n${replyStyle}` : '';
}
