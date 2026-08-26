import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAdmissionTools } from './features/admission/index.js';
import { registerDetectionTools } from './features/detection/index.js';
import { registerManifestTools } from './features/manifest/index.js';
import { StatelessHttpTransport } from './shared/mcp-client/stateless-http-transport.js';

/**
 * The Vetit MCP server.
 *
 * Transport wiring only. Each feature registers its own tools through a single
 * exported function, so adding a feature means adding one line here and
 * nothing else — and so that nothing outside a feature folder knows how that
 * feature works.
 *
 * `McpServer` rather than the low-level `Server`, on purpose: it produces a
 * well-formed manifest with the annotations exactly as declared. Vetit's own
 * tool descriptions are short, plain, and contain no instructions, because a
 * tool that catches servers addressing the model has no business doing it.
 */

const SERVER_IDENTITY = { name: 'vetit', version: '0.1.0' } as const;

export function createVetitMcpServer(): McpServer {
  const server = new McpServer(SERVER_IDENTITY);
  registerManifestTools(server);
  registerDetectionTools(server);
  registerAdmissionTools(server);
  return server;
}

interface McpExchange {
  readonly request: express.Request;
  readonly response: express.Response;
}

async function handleMcpPost(exchange: McpExchange): Promise<void> {
  const { request, response } = exchange;
  const server = createVetitMcpServer();
  const transport = new StatelessHttpTransport();
  response.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest({ request, response }, request.body);
}

export function createVetitApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok', server: SERVER_IDENTITY.name });
  });

  app.post('/mcp', (request, response) => {
    handleMcpPost({ request, response }).catch(() => {
      if (!response.headersSent) response.status(500).end();
    });
  });

  // Stateless: nothing to resume, no session to delete.
  app.get('/mcp', (_request, response) => response.status(405).end());
  app.delete('/mcp', (_request, response) => response.status(405).end());

  return app;
}
