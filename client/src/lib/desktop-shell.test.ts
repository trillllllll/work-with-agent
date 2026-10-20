import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inDesktopShell, markDesktopShell, notificationSupport, setNotificationMode, systemNotify } from './desktop-shell.js';

function memoryStorage() { const map = new Map<string, string>(); return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } }; }

describe('system notifications', () => {
  let assigned: string[]; let shown: Array<{ title: string; body?: string }>;
  beforeEach(() => {
    assigned = []; shown = [];
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('window', { location: { assign: (url: string) => assigned.push(url) } });
    vi.stubGlobal('document', { visibilityState: 'hidden', hasFocus: () => false });
    class FakeNotification { static permission = 'granted'; constructor(title: string, options?: { body?: string }) { shown.push({ title, body: options?.body }); } }
    vi.stubGlobal('Notification', FakeNotification);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('uses the browser Notification API only when the page is in the background', async () => {
    expect(notificationSupport()).toBe('granted');
    expect(await systemNotify('任务待验收', 'body')).toBe(true);
    expect(shown).toEqual([{ title: '任务待验收', body: 'body' }]);
    vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => true });
    expect(await systemNotify('again', 'body')).toBe(false);
  });
  it('respects the per-device off switch', async () => {
    setNotificationMode('off');
    expect(await systemNotify('x', 'y')).toBe(false);
    expect(shown).toEqual([]);
  });
  it('asks the desktop shell through IPC, or the sentinel navigation when the origin has no IPC', async () => {
    markDesktopShell();
    expect(inDesktopShell()).toBe(true);
    expect(notificationSupport()).toBe('desktop');
    expect(await systemNotify('任务待验收', '完成了')).toBe(true);
    expect(assigned).toHaveLength(1);
    const url = new URL(assigned[0], 'http://x');
    expect(url.pathname).toBe('/wwa-notify');
    expect(url.searchParams.get('title')).toBe('任务待验收');
    const invoke = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', { __TAURI__: { core: { invoke } }, location: { assign: (value: string) => assigned.push(value) } });
    expect(await systemNotify('t', 'b')).toBe(true);
    expect(invoke).toHaveBeenCalledWith('desktop_notify', { title: 't', body: 'b' });
    expect(assigned).toHaveLength(1);
    expect(shown).toEqual([]);
  });
});
