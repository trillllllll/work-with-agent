import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, mcpCredential } from './create-server.js';

const credential = process.env.WWA_CONNECTION_TOKEN;
if (!credential) throw new Error('WWA_CONNECTION_TOKEN is required; create a scoped connection in the workspace');

const server = createMcpServer();
await mcpCredential.run(credential, () => server.connect(new StdioServerTransport()));
