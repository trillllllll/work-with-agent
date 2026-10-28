import webpush from 'web-push';
import { prisma } from '../infrastructure/prisma.js';
import { defaultMobileNavigationJson } from '../domain/mobile-navigation.js';

export type PushPayload = { title: string; body: string; url?: string; tag?: string };

const FALLBACK_SUBJECT = 'mailto:dovun@localhost';
const envKey = (name: string) => process.env[name]?.trim() || undefined;

/**
 * VAPID identity for this workspace. `DOVUN_VAPID_*` environment variables win; otherwise the
 * first use generates a keypair and stores it in AppSetting, so restarts keep the same identity
 * and existing browser subscriptions stay valid. Keys never leave the server logs.
 */
export async function vapidKeys(): Promise<{ publicKey: string; privateKey: string; subject: string }> {
  const envPublic = envKey('DOVUN_VAPID_PUBLIC_KEY');
  const envPrivate = envKey('DOVUN_VAPID_PRIVATE_KEY');
  if (envPublic && envPrivate) return { publicKey: envPublic, privateKey: envPrivate, subject: envKey('DOVUN_VAPID_SUBJECT') ?? FALLBACK_SUBJECT };
  const row = await prisma.appSetting.findUnique({ where: { id: 'default' }, select: { vapidPublicKey: true, vapidPrivateKey: true, vapidSubject: true } });
  if (row?.vapidPublicKey && row?.vapidPrivateKey) return { publicKey: row.vapidPublicKey, privateKey: row.vapidPrivateKey, subject: row.vapidSubject || FALLBACK_SUBJECT };
  const generated = webpush.generateVAPIDKeys();
  const timestamp = new Date().toISOString();
  await prisma.appSetting.upsert({
    where: { id: 'default' },
    create: { id: 'default', mobileNavigationJson: defaultMobileNavigationJson, vapidPublicKey: generated.publicKey, vapidPrivateKey: generated.privateKey, vapidSubject: FALLBACK_SUBJECT, createdAt: timestamp, updatedAt: timestamp },
    update: { vapidPublicKey: generated.publicKey, vapidPrivateKey: generated.privateKey, updatedAt: timestamp },
  });
  return { publicKey: generated.publicKey, privateKey: generated.privateKey, subject: FALLBACK_SUBJECT };
}

/** Public part for browsers; available=false means Web Push cannot work here yet. */
export async function pushConfig() {
  try {
    const { publicKey } = await vapidKeys();
    return { publicKey, available: true };
  } catch (error) {
    console.error('推送配置不可用：', error);
    return { publicKey: '', available: false };
  }
}

export async function subscribePush(input: { endpoint: string; keys: { p256dh: string; auth: string } }, label = '', timeZone = '') {
  const timestamp = new Date().toISOString();
  const existing = await prisma.pushSubscription.findUnique({ where: { endpoint: input.endpoint }, select: { id: true } });
  const data = { endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, label, timeZone, lastUsedAt: timestamp };
  if (existing) await prisma.pushSubscription.update({ where: { id: existing.id }, data });
  else await prisma.pushSubscription.create({ data: { ...data, createdAt: timestamp } });
  return { count: await prisma.pushSubscription.count() };
}

export async function unsubscribePush(endpoint: string) {
  const removed = await prisma.pushSubscription.deleteMany({ where: { endpoint } });
  return { removed: removed.count, count: await prisma.pushSubscription.count() };
}

/** Best-effort fan-out. Gone subscriptions (404/410) are dropped; other failures keep them. */
export async function sendPushToAll(payload: PushPayload) {
  let keys: Awaited<ReturnType<typeof vapidKeys>>;
  try { keys = await vapidKeys(); } catch { return { sent: 0, removed: 0 }; }
  const options = { TTL: 3600, vapidDetails: { subject: keys.subject, publicKey: keys.publicKey, privateKey: keys.privateKey } };
  const subscriptions = await prisma.pushSubscription.findMany();
  let sent = 0;
  let removed = 0;
  const timestamp = new Date().toISOString();
  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify(payload), options);
      await prisma.pushSubscription.update({ where: { id: subscription.id }, data: { lastUsedAt: timestamp } });
      sent += 1;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await prisma.pushSubscription.delete({ where: { id: subscription.id } }).catch(() => {});
        removed += 1;
      } else if (status !== 401) {
        // 401 means our VAPID key was rejected (e.g. an env key changed) — stay quiet per device.
        console.warn('推送失败：', status ?? error);
      }
    }
  }
  return { sent, removed };
}

export async function sendTestPush(title: string, body: string) {
  const result = await sendPushToAll({ title, body, url: '/', tag: 'dovun-test' });
  if (!result.sent && !(await prisma.pushSubscription.count())) return { sent: 0, removed: result.removed, noSubscriptions: true };
  return { ...result, noSubscriptions: false };
}
