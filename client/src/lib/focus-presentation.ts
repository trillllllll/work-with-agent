const blockedFocusOrigins = new Set(['focus', 'chat', 'settings', 'trash', 'changes']);

/** Route head of a hash URL. An empty hash is the inbox. */
export function hashRouteHead(hash: string) {
  const path = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  return path.split('/')[0] ?? '';
}

/**
 * Origin recorded when sidebar, More, or the mobile tab opens #/focus.
 * The focus page itself, the assistant, and workspace modals are not return targets.
 */
export function focusOriginFromNavigation(hash: string): { hash: string } | null {
  if (blockedFocusOrigins.has(hashRouteHead(hash))) return null;
  return { hash: hash || '#/inbox' };
}
