export type ModelSettingsRoutePolicy = 'hub' | 'unsupported' | null;

const profileId = '[^/%]+';
const supportedRoutes: Array<[RegExp, ReadonlySet<string>]> = [
  [/^\/api\/settings$/, new Set(['GET', 'PATCH'])],
  [/^\/api\/settings\/profiles$/, new Set(['POST'])],
  [new RegExp(`^/api/settings/profiles/${profileId}$`), new Set(['PATCH', 'DELETE'])],
  [new RegExp(`^/api/settings/profiles/${profileId}/(?:activate|copy)$`), new Set(['POST'])],
  [/^\/api\/settings\/models$/, new Set(['POST'])],
  [/^\/api\/settings\/context-window\/probe$/, new Set(['POST'])],
  [/^\/api\/settings\/api-key$/, new Set(['DELETE'])],
];

export function modelSettingsRoutePolicy(method: string, path: string): ModelSettingsRoutePolicy {
  // Express matches route names case-insensitively and accepts one trailing slash.
  // Classify the same shapes here, while leaving the forwarded URL/IDs unchanged.
  path = path.toLowerCase().replace(/\/$/, '');
  const family = path === '/api/settings'
    || path === '/api/settings/profiles' || path.startsWith('/api/settings/profiles/')
    || path === '/api/settings/models' || path.startsWith('/api/settings/models/')
    || path === '/api/settings/context-window' || path.startsWith('/api/settings/context-window/')
    || path === '/api/settings/api-key' || path.startsWith('/api/settings/api-key/');
  if (!family) return null;
  const upperMethod = method.toUpperCase();
  return supportedRoutes.some(([pattern, methods]) => pattern.test(path) && methods.has(upperMethod)) ? 'hub' : 'unsupported';
}
