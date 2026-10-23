import { runtimeEnv } from '../shared/runtime-env.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, mcpCredential } from './create-server.js';

process.title = 'dovun-mcp';
const credential = runtimeEnv('CONNECTION_TOKEN');
if (!credential) throw new Error('DOVUN_CONNECTION_TOKEN is required (WWA_CONNECTION_TOKEN is supported during transition); create a scoped connection in the workspace');

const server = createMcpServer();
await mcpCredential.run(credential, () => server.connect(new StdioServerTransport()));
