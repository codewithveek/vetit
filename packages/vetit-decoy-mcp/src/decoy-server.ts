/* eslint-disable @typescript-eslint/no-deprecated --
   The low-level `Server` is the right choice here, and the SDK says so: it is
   for "advanced use cases". Publishing a manifest with homoglyph tool names,
   invisible characters and annotations that contradict behaviour is exactly
   that. `McpServer` would generate a well-formed manifest, which is the one
   thing this package must not do. */
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StatelessHttpTransport } from './mcp-http-transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { buildToolCatalogue } from './tool-catalogue.js';
import { callDecoyTool } from './tool-handlers.js';

/**
 * Streamable HTTP transport wiring, in stateless mode: one MCP server and one
 * transport per request. A review tool connects, lists, calls and disconnects,
 * so there is no session worth keeping.
 */

export interface DecoyServerOptions {
  readonly isPoisoned: boolean;
}

function createMcpServer(options: DecoyServerOptions): Server {
  const server = new Server(
    { name: 'vetit-decoy-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: buildToolCatalogue({ isPoisoned: options.isPoisoned }),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callDecoyTool({
      toolName: request.params.name,
      args: request.params.arguments ?? {},
    }),
  );

  return server;
}

interface McpExchange {
  readonly request: express.Request;
  readonly response: express.Response;
}

async function handleMcpPost(
  exchange: McpExchange,
  options: DecoyServerOptions,
): Promise<void> {
  const { request, response } = exchange;
  const server = createMcpServer(options);
  const transport = new StatelessHttpTransport();
  response.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest({ request, response }, request.body);
}

export function createDecoyApp(options: DecoyServerOptions): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok', poisoned: options.isPoisoned });
  });

  app.post('/mcp', (request, response) => {
    handleMcpPost({ request, response }, options).catch(() => {
      if (!response.headersSent) response.status(500).end();
    });
  });

  // Stateless: there is no stream to resume and no session to delete.
  app.get('/mcp', (_request, response) => response.status(405).end());
  app.delete('/mcp', (_request, response) => response.status(405).end());

  return app;
}
