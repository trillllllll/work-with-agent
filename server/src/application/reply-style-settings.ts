import { prisma } from '../infrastructure/prisma.js';
import { defaultMobileNavigationJson } from '../domain/mobile-navigation.js';

export const DEFAULT_REPLY_STYLE = `先说结论：第一句直接回答问题，不铺垫、不复述提问。用日常语言和短句，一段只讲一层逻辑，因果关系讲清楚。
先具体后抽象：解释原理先说它解决什么问题，用具体场景，再总结规律。专业术语可以用，首次出现先简单解释，不用术语堆砌。
按问题深度回答：问现象和结果时用业务语言，不堆字段和代码位置；问具体哪里改时才给函数名、字段和位置。首次回答只解决当前疑问，被追问再深入；不省略影响判断的风险。
区分已确认事实与推测，未验证的判断注明待验证。
简单问题简短回答，不凑篇幅；不复述排查过程；结尾不换种说法重复全文；不强行总结、升华或延伸话题。信息不足时直接说明缺什么。`;

export const LEGACY_DEFAULT_REPLY_STYLE = '结论先行，多用短句。';

export async function replyStyleSettings() {
  const row = await prisma.appSetting.findUnique({ where: { id: 'default' }, select: { replyStyle: true } });
  // 旧安装的存量行和省略 replyStyle 的各处 upsert 创建仍会按 schema 默认写入旧文案；
  // 读到旧文案按当前默认解释，语义等同于"跟随默认"。空串和其他自定义值原样返回。
  const stored = row?.replyStyle;
  const replyStyle = stored == null || stored === LEGACY_DEFAULT_REPLY_STYLE ? DEFAULT_REPLY_STYLE : stored;
  return { replyStyle, defaultReplyStyle: DEFAULT_REPLY_STYLE };
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
