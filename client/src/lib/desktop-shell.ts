/**
 * Bridges to the desktop shell. The shell intercepts these sentinel navigations (they never reach a server),
 * which works for both the bundled local workspace and a remote workspace loaded in the desktop window.
 */
const SHELL_KEY = 'wwa-desktop-shell';
const NOTIFY_KEY = 'wwa-system-notifications';

export function markDesktopShell() { try { localStorage.setItem(SHELL_KEY, '1'); } catch { /* storage unavailable */ } }
export function inDesktopShell() {
  if (typeof window === 'undefined') return false;
  if ('__TAURI__' in window) return true;
  try { return localStorage.getItem(SHELL_KEY) === '1'; } catch { return false; }
}

export type NotificationMode = 'off' | 'on';
export function notificationMode(): NotificationMode {
  try { return localStorage.getItem(NOTIFY_KEY) === 'off' ? 'off' : 'on'; } catch { return 'on'; }
}
export function setNotificationMode(mode: NotificationMode) { try { localStorage.setItem(NOTIFY_KEY, mode); } catch { /* storage unavailable */ } }

/** Browser permission state, or 'desktop' when the desktop shell shows notifications itself. */
export function notificationSupport(): 'desktop' | 'granted' | 'denied' | 'default' | 'unsupported' {
  if (inDesktopShell()) return 'desktop';
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}
export async function requestNotificationPermission() {
  if (inDesktopShell() || typeof Notification === 'undefined') return notificationSupport();
  return Notification.requestPermission();
}

type TauriGlobal = { core?: { invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> } };

/** System notification for things that need the user (orchestration awaiting acceptance / paused). Returns whether one was shown. */
export async function systemNotify(title: string, body: string, tag?: string) {
  if (notificationMode() === 'off') return false;
  if (inDesktopShell()) {
    const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
    try {
      if (tauri?.core?.invoke) { await tauri.core.invoke('desktop_notify', { title, body }); return true; }
    } catch { /* A remote origin has no IPC; fall back to the sentinel navigation. */ }
    const params = new URLSearchParams({ title, body });
    window.location.assign(`/wwa-notify?${params.toString()}`);
    return true;
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  // Only when the tab is not in front; the in-app toast covers the visible case.
  if (document.visibilityState === 'visible' && document.hasFocus()) return false;
  try { new Notification(title, { body, tag }); return true; } catch { return false; }
}

/** Desktop only: hand a freshly issued node token to the shell, which asks for the code folder and starts wwa-node. */
export function pairNodeOnThisComputer(server: string, token: string) {
  const params = new URLSearchParams({ server, token });
  window.location.assign(`/wwa-node-pair?${params.toString()}`);
}
export function stopNodeOnThisComputer() { window.location.assign('/wwa-node-unpair'); }
