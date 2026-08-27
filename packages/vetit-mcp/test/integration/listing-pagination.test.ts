import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Server as McpLowLevelServer } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ErrorCode,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { listTargetSurface } from '../../src/shared/mcp-client/index.js';
import { StatelessHttpTransport } from '../../../vetit-decoy-mcp/src/mcp-http-transport.js';

/**
 * A target that paginates, and a target that fails.
 *
 * The decoy publishes everything in one page, so neither behaviour could be
 * reached through it. These two servers exist only to answer the questions the
 * decoy cannot: does Vetit follow a cursor to the end, and does it tell a
 * server saying "I do not offer that" apart from a server that simply broke?
 */

/* eslint-disable @typescript-eslint/no-deprecated --
   The low-level Server is the right tool for a fixture that has to control
   pagination and error codes exactly, which is what these tests are about. */

const PAGE_SIZE = 2;
const TOTAL_TOOLS = 7;

function toolNumbered(index: number): Tool {
  return {
    name: `tool_${String(index)}`,
    description: `Tool number ${String(index)}.`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false },
  };
}

const ALL_TOOLS: readonly Tool[] = Array.from({ length: TOTAL_TOOLS }, (_, index) =>
  toolNumbered(index),
);

interface FixtureBehaviour {
  /** What resources/list and prompts/list should do. */
  readonly listingFailure?: 'method-not-found' | 'internal-error' | 'undeclared';
  /** Hand back a cursor that has already been used. */
  readonly loopCursor?: boolean;
}

function toolsPage(cursor: string | undefined): {
  tools: Tool[];
  nextCursor?: string;
} {
  const start = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
  const tools = ALL_TOOLS.slice(start, start + PAGE_SIZE);
  const next = start + PAGE_SIZE;
  return next < ALL_TOOLS.length
    ? { tools, nextCursor: String(next) }
    : { tools };
}

function registerListings(
  server: McpLowLevelServer,
  behaviour: FixtureBehaviour,
): void {
  server.setRequestHandler(ListToolsRequestSchema, (request) =>
    behaviour.loopCursor === true
      ? { tools: [toolNumbered(0)], nextCursor: 'stuck' }
      : toolsPage(request.params?.cursor),
  );
  // A server that never declared the capability cannot register a handler for
  // it — the SDK refuses. That is the shape of the `undeclared` fixture: the
  // refusal then happens on the client side, before anything is sent.
  if (behaviour.listingFailure === 'undeclared') return;

  server.setRequestHandler(ListResourcesRequestSchema, () => {
    if (behaviour.listingFailure === 'method-not-found') {
      throw new McpError(ErrorCode.MethodNotFound, 'resources/list not implemented');
    }
    if (behaviour.listingFailure === 'internal-error') {
      throw new McpError(ErrorCode.InternalError, 'the database is on fire');
    }
    return { resources: [{ uri: 'file://a', name: 'a' }] };
  });
  server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [] }));
}

function buildApp(behaviour: FixtureBehaviour): express.Express {
  const app = express();
  app.use(express.json());
  app.post('/mcp', (request, response) => {
    const server = new McpLowLevelServer(
      { name: 'pagination-fixture', version: '0.1.0' },
      {
        capabilities:
          behaviour.listingFailure === 'undeclared'
            ? { tools: {} }
            : { tools: {}, resources: {}, prompts: {} },
      },
    );
    registerListings(server, behaviour);
    const transport = new StatelessHttpTransport();
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    void server
      .connect(transport)
      .then(async () => {
        await transport.handleRequest({ request, response }, request.body);
      })
      .catch(() => {
        if (!response.headersSent) response.status(500).end();
      });
  });
  return app;
}

let running: Server | undefined;

async function startFixture(behaviour: FixtureBehaviour): Promise<string> {
  const server = createServer(buildApp(behaviour));
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  running = server;
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${String(address.port)}/mcp`;
}

afterEach(async () => {
  const server = running;
  running = undefined;
  if (server === undefined) return;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

describe('pagination', () => {
  it('follows nextCursor to the end instead of reading one page', async () => {
    const url = await startFixture({});
    const listing = await listTargetSurface({ url });
    expect(listing.tools).toHaveLength(TOTAL_TOOLS);
    expect(listing.pageCounts.tools).toBe(4);
  });

  it('keeps every page in order', async () => {
    const url = await startFixture({});
    const listing = await listTargetSurface({ url });
    const names = listing.tools.map((tool) =>
      typeof tool === 'object' && tool !== null && 'name' in tool
        ? String(tool.name)
        : '',
    );
    expect(names).toEqual(ALL_TOOLS.map((tool) => tool.name));
  });

  it('refuses a cursor that never terminates', async () => {
    const url = await startFixture({ loopCursor: true });
    await expect(listTargetSurface({ url })).rejects.toThrow(/repeated a pagination cursor/);
  });
});

describe('telling absence from failure', () => {
  it('records an unimplemented listing as absent', async () => {
    const url = await startFixture({ listingFailure: 'method-not-found' });
    const listing = await listTargetSurface({ url });
    expect(listing.resources).toBeUndefined();
    expect(listing.tools).toHaveLength(TOTAL_TOOLS);
  });

  it('records an undeclared capability as absent', async () => {
    const url = await startFixture({ listingFailure: 'undeclared' });
    const listing = await listTargetSurface({ url });
    expect(listing.resources).toBeUndefined();
    expect(listing.prompts).toBeUndefined();
  });

  it('fails the fetch when the server broke, rather than reporting nothing there', async () => {
    // This is the finding: a target that errors on resources/list used to be
    // recorded as having no resources, which reads as a complete review of a
    // server nobody actually finished reading.
    const url = await startFixture({ listingFailure: 'internal-error' });
    await expect(listTargetSurface({ url })).rejects.toThrow(/database is on fire/);
  });

  it('lists resources normally when the server offers them', async () => {
    const url = await startFixture({});
    const listing = await listTargetSurface({ url });
    expect(listing.resources).toHaveLength(1);
  });
});
