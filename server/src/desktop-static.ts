import express, { type Express } from 'express';
import { resolve } from 'node:path';

/** Serves the built client from the same origin as the API. API and MCP routes are registered first and keep precedence. */
export function mountDesktopStatic(app: Express, directory: string) {
  app.use(express.static(resolve(directory), { index: 'index.html', fallthrough: true, redirect: false }));
}
