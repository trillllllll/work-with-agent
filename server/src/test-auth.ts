import supertest from 'supertest';
import type { Express } from 'express';
import { createOwnerBootstrapToken } from './application/security.js';
import { prisma } from './infrastructure/prisma.js';

const sessions = new WeakMap<Express, Promise<{ cookie: string; csrf: string }>>();
export async function ownerSession(app: Express) {
  let session = sessions.get(app);
  if (!session) {
    session = (async () => {
      const response = await supertest(app).post('/api/v1/auth/session').send({ bootstrapToken: createOwnerBootstrapToken() });
      if (response.status !== 200) throw new Error(`Owner login failed: ${JSON.stringify(response.body)}`);
      return { cookie: (response.headers['set-cookie'] as unknown as string[])[0].split(';')[0], csrf: response.body.data.csrfToken as string };
    })();
    sessions.set(app, session);
  }
  return session;
}

/** Legacy behavior suites explicitly authenticate and supply the versions their
 * fixtures read. Security/CAS suites use raw supertest to exercise absent/stale values. */
export default function ownerRequest(app: Express) {
  type Builder = PromiseLike<supertest.Response> & {
    send(value: unknown): Builder;
    set(key: string, value: string): Builder;
    query(value: unknown): Builder;
  };
  const build = (method: 'get' | 'post' | 'patch' | 'delete', path: string) => {
    let body: any;
    const headers: Record<string, string> = {};
    let query: any;
    const execute = async () => {
      const session = await ownerSession(app);
      if (method !== 'get' && (!body || typeof body === 'object') && !Array.isArray(body)) {
        body = { ...(body ?? {}) };
        const match = path.match(/^\/api\/(tasks|topics|tags)\/([^/?]+)/);
        const trash = path.match(/^\/api\/trash\/tasks\/([^/]+)/);
        if (body.expectedRevision === undefined && (match || trash)) {
          const kind = trash ? 'tasks' : match![1];
          const id = trash?.[1] ?? match![2];
          const row = kind === 'tasks' ? await prisma.task.findUnique({ where: { id } }) : kind === 'topics' ? await prisma.topic.findUnique({ where: { id } }) : await prisma.tag.findUnique({ where: { id } });
          if (row) body.expectedRevision = row.revision;
        }
        if (path === '/api/tasks/reorder' && body.expectedRevisions === undefined) {
          const rows = await prisma.task.findMany({ where: { topicId: body.topicId, parentId: body.parentId, deletedAt: null } });
          body.expectedRevisions = Object.fromEntries(rows.map((row) => [row.id, row.revision]));
        }
      }
      let request = supertest(app)[method](path).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
      for (const [key, value] of Object.entries(headers)) request = request.set(key, value);
      if (query !== undefined) request = request.query(query);
      if (body !== undefined) request = request.send(body);
      const response = await request;
      if (response.status === 428 && response.body.code === 'PREVIEW_REQUIRED') {
        const preview = await supertest(app).post('/api/v1/commands/preview').set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({ commands: response.body.details.commands });
        if (preview.status !== 200) return preview;
        let retry = supertest(app)[method](path).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
        for (const [key, value] of Object.entries(headers)) retry = retry.set(key, value);
        return retry.send({ ...body, previewToken: preview.body.data.previewToken });
      }
      return response;
    };
    const builder: Builder = {
      send(value: unknown) { body = value; return builder; },
      set(key: string, value: string) { headers[key] = value; return builder; },
      query(value: unknown) { query = value; return builder; },
      then(resolve, reject) { return execute().then(resolve, reject); },
    };
    return builder;
  };
  return { get: (path: string) => build('get', path), post: (path: string) => build('post', path), patch: (path: string) => build('patch', path), delete: (path: string) => build('delete', path) };
}
