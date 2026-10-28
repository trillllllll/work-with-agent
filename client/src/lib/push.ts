import { api } from './api.js';
import { inDesktopShell } from './desktop-shell.js';

export type PushConfig = { publicKey: string; available: boolean };
export type SubscribeResult = { count: number };
export type UnsubscribeResult = { removed: number; count: number };
export type TestResult = { sent: number; removed: number; noSubscriptions: boolean };

/** Why the push card is in its current state; drives the hint text in settings. */
export type PushSupport = 'desktop' | 'granted' | 'denied' | 'default' | 'unsupported' | 'insecure' | 'ios-browser';

export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)')?.matches === true
    || (window.navigator as { standalone?: boolean }).standalone === true;
}

function isIos() {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** The desktop app shows notifications itself; iOS browsers must be installed to the home screen first. */
export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (inDesktopShell()) return 'desktop';
  if (typeof Notification === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (isIos() && !isStandalone()) return 'ios-browser';
  return Notification.permission;
}

function applicationServerKey(publicKey: string) {
  const padding = '='.repeat((4 - (publicKey.length % 4)) % 4);
  const base64 = (publicKey + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

function deviceLabel() {
  if (typeof navigator === 'undefined') return '';
  return isIos() ? 'iOS' : /Android/.test(navigator.userAgent) ? 'Android' : /Mac/.test(navigator.platform) ? 'macOS' : /Win/.test(navigator.platform) ? 'Windows' : '';
}

/** One-shot subscribe: asks permission, creates the browser subscription, and registers it server-side. */
export async function subscribeToPush(): Promise<{ ok: true; endpoint: string; count: number } | { ok: false; reason: string }> {
  const config = await api<PushConfig>('/api/push/config');
  if (!config.available || !config.publicKey) return { ok: false, reason: 'unavailable' };
  // The offline worker is only registered in production builds; without it there is nothing to push to.
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return { ok: false, reason: 'no-worker' };
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: permission };
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(config.publicKey) });
  }
  const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return { ok: false, reason: 'invalid' };
  const result = await api<SubscribeResult>('/api/push/subscribe', { method: 'POST', body: JSON.stringify({
    endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    label: deviceLabel(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
  }) });
  return { ok: true, endpoint: json.endpoint, count: result.count };
}

export async function unsubscribeFromPush(): Promise<UnsubscribeResult | { removed: 0; count: number; localOnly: true }> {
  const subscription = await currentPushSubscription();
  await subscription?.unsubscribe();
  if (!subscription) return { removed: 0, count: 0, localOnly: true };
  return api<UnsubscribeResult>('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint }) });
}

export async function sendTestPush(): Promise<TestResult> {
  return api<TestResult>('/api/push/test', { method: 'POST' });
}
