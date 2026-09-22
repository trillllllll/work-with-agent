import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { connectionTokenActive } from '../application/security.js';
import { createMcpServer, mcpCredential } from './create-server.js';

type Session = { transport: StreamableHTTPServerTransport; credential: string };

function bearer(req: Request) {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

/** MCP is served by the workspace API process. Starting WWA starts this endpoint. */
export function mountMcp(app: Express, authorize: (token: string) => Promise<boolean> = connectionTokenActive) {
  const sessions = new Map<string, Session>();
  app.all('/mcp', async (req: Request, res: Response) => {
    const token = bearer(req);
    const sessionId = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;
    try {
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing) {
        if (!token || token !== existing.credential || !(await authorize(token))) {
          res.status(401).json({ error: '连接凭据无效或已撤销' });
          return;
        }
        await mcpCredential.run(existing.credential, () => existing.transport.handleRequest(req, res, req.method === 'POST' ? req.body : undefined));
        return;
      }
      if (req.method !== 'POST' || !token || !(await authorize(token))) {
        res.status(req.method === 'POST' ? 401 : 400).json({ error: req.method === 'POST' ? '连接凭据无效或已撤销' : '需要已建立的 MCP 会话' });
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { sessions.set(id, { transport, credential: token }); },
        onsessionclosed: (id) => { sessions.delete(id); },
      });
      await createMcpServer().connect(transport);
      await mcpCredential.run(token, () => transport.handleRequest(req, res, req.body));
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: error instanceof Error ? error.message : 'MCP 请求失败' });
    }
  });
}
