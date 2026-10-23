/** One-release bridge for old shells and cached pages. */
export function installLegacyEventBridge() {
  const target = window as Window & { __DOVUN_CLIENT__?: boolean };
  if (target.__DOVUN_CLIENT__) return;
  target.__DOVUN_CLIENT__ = true;
  for (const name of ["skill-saved", "adjust-approval", "cancel-upload", "desktop", "focus-assistant", "locate-approval", "open-assistant", "open-focus", "open-skill-editor", "open-source", "open-task", "preview-material"]) {
    window.addEventListener(`wwa-${name}`, event => window.dispatchEvent(new CustomEvent(`dovun-${name}`, { detail: (event as CustomEvent).detail })));
  }
}
