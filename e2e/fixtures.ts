import { test as base, expect, type APIRequestContext } from '@playwright/test';
export { expect };
export type { APIRequestContext, Page } from '@playwright/test';

// Explicit authenticated client fixture. Production authorization remains enabled.
export const test = base.extend({
  request: async ({ request }, use) => {
    const wrapped = new Proxy(request, { get(target, property) {
      const original = Reflect.get(target, property);
      if (typeof original !== 'function') return original;
      if (!['post', 'patch', 'delete'].includes(String(property))) return original.bind(target);
      return async (url: string, options: any = {}) => {
        const path = new URL(url).pathname;
        let data = typeof options.data === 'object' ? { ...options.data } : {};
        const match = path.match(/^\/api\/(tasks|topics|tags|trash\/tasks)\/([^/]+)/);
        if (path === '/api/tasks/reorder' && !data.expectedRevisions) {
          const response = await target.get(new URL('/api/tasks?status=all', url).href);
          const rows = (await response.json()).data ?? [];
          data.expectedRevisions = Object.fromEntries(rows.filter((row: any) => data.orderedTaskIds?.includes(row.id)).map((row: any) => [row.id, row.revision]));
        } else if (match && data.expectedRevision === undefined) {
          let row: any;
          if (match[1] === 'tags' || match[1] === 'trash/tasks') {
            const response = await target.get(new URL(match[1] === 'tags' ? '/api/tags' : '/api/trash/tasks', url).href);
            row = ((await response.json()).data ?? []).find((item: any) => item.id === match[2]);
          } else {
            const response = await target.get(new URL(`/api/${match[1]}/${match[2]}?includeArchived=true`, url).href);
            row = (await response.json()).data;
          }
          if (row?.revision !== undefined) data.expectedRevision = row.revision;
        }
        const response = await original.call(target, url, { ...options, data });
        if (response.status() !== 428) return response;
        const payload = await response.json();
        if (payload.code !== 'PREVIEW_REQUIRED' || !payload.details?.commands) return response;
        const preview = await target.post(new URL('/api/v1/commands/preview', url).href, { data: { commands: payload.details.commands } });
        const previewToken = (await preview.json()).data?.previewToken;
        return original.call(target, url, { ...options, data: { ...data, previewToken } });
      };
    } }) as APIRequestContext;
    await use(wrapped);
  },
});
