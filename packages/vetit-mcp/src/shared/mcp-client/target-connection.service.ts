import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { StreamableClientTransport } from './streamable-client-transport.js';

/**
 * Talking to a server we do not trust.
 *
 * Everything this module returns is `unknown` on purpose. The target decides
 * what comes back, so nothing here may assume a shape — the manifest schemas
 * check it, and the redaction layer cleans anything that reaches a report.
 */

const CLIENT_IDENTITY = { name: 'vetit-review', version: '0.1.0' } as const;
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * A hostile server can paginate forever, or hand back a cursor it has already
 * given you. Neither should be able to hold a review open indefinitely, so
 * both are bounded and both are errors rather than silent truncation.
 */
const MAX_PAGES = 100;

const listPageSchema = z
  .object({ nextCursor: z.string().optional() })
  .catchall(z.unknown());

export interface TargetConnectionOptions {
  readonly url: string;
  readonly timeoutMs?: number;
}

/** How many pages each listing took. Evidence that pagination actually ran. */
export interface PageCounts {
  readonly tools: number;
  readonly resources: number;
  readonly prompts: number;
}

export interface TargetListing {
  readonly serverInfo: unknown;
  readonly capabilities: unknown;
  /** Every item from every page, exactly as the target sent them. */
  readonly tools: readonly unknown[];
  /** `undefined` means the server does not offer the operation at all. */
  readonly resources: readonly unknown[] | undefined;
  readonly prompts: readonly unknown[] | undefined;
  readonly pageCounts: PageCounts;
}

export class TargetListingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetListingError';
  }
}

/**
 * Two things, and only these two, mean "this server does not offer that".
 *
 * A JSON-RPC MethodNotFound is the server saying so. The SDK also refuses
 * client-side, before sending anything, when the server never declared the
 * capability. Everything else — a timeout, a closed connection, a malformed
 * response, an internal error on the target — is a failure to find out, and a
 * failure to find out must never be recorded as an absence.
 */
/** Widened deliberately: `McpError.code` is a plain number off the wire. */
const METHOD_NOT_FOUND_CODE: number = ErrorCode.MethodNotFound;

function isUnsupportedOperation(error: unknown): boolean {
  if (error instanceof McpError) return error.code === METHOD_NOT_FOUND_CODE;
  return (
    error instanceof Error && error.message.startsWith('Server does not support ')
  );
}

interface PagedListOptions {
  /** Calls one page. `undefined` asks for the first. */
  readonly listPage: (cursor: string | undefined) => Promise<unknown>;
  readonly itemsKey: 'tools' | 'resources' | 'prompts';
}

interface PagedResult {
  readonly items: unknown[];
  readonly pages: number;
}

function itemsFromPage(page: Record<string, unknown>, itemsKey: string): unknown[] {
  const value = page[itemsKey];
  return Array.isArray(value) ? value : [];
}

/**
 * Follows `nextCursor` to the end.
 *
 * MCP list operations are paginated. Reading one page and stopping produced
 * counts and hashes that described the first page rather than the server, so a
 * target could hide every interesting tool behind a cursor and review clean.
 */
async function collectAllPages(options: PagedListOptions): Promise<PagedResult> {
  const items: unknown[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const parsed = listPageSchema.safeParse(await options.listPage(cursor));
    if (!parsed.success) {
      throw new TargetListingError(
        `${options.itemsKey}/list returned a response that is not an object.`,
      );
    }
    items.push(...itemsFromPage(parsed.data, options.itemsKey));

    const next = parsed.data.nextCursor;
    if (next === undefined) return { items, pages: page };
    if (seenCursors.has(next)) {
      throw new TargetListingError(
        `${options.itemsKey}/list repeated a pagination cursor, which never terminates.`,
      );
    }
    seenCursors.add(next);
    cursor = next;
  }
  throw new TargetListingError(
    `${options.itemsKey}/list did not finish within ${String(MAX_PAGES)} pages.`,
  );
}

async function collectIfSupported(
  options: PagedListOptions,
): Promise<PagedResult | undefined> {
  try {
    return await collectAllPages(options);
  } catch (error) {
    if (isUnsupportedOperation(error)) return undefined;
    throw error;
  }
}

interface SurfaceReader {
  readonly client: Client;
  readonly requestOptions: { readonly timeout: number };
}

function pageParams(cursor: string | undefined): { cursor: string } | undefined {
  return cursor === undefined ? undefined : { cursor };
}

async function readSurface(reader: SurfaceReader): Promise<TargetListing> {
  const { client, requestOptions } = reader;
  const tools = await collectAllPages({
    itemsKey: 'tools',
    listPage: async (cursor) =>
      await client.listTools(pageParams(cursor), requestOptions),
  });
  const resources = await collectIfSupported({
    itemsKey: 'resources',
    listPage: async (cursor) =>
      await client.listResources(pageParams(cursor), requestOptions),
  });
  const prompts = await collectIfSupported({
    itemsKey: 'prompts',
    listPage: async (cursor) =>
      await client.listPrompts(pageParams(cursor), requestOptions),
  });
  return {
    serverInfo: client.getServerVersion(),
    capabilities: client.getServerCapabilities(),
    tools: tools.items,
    resources: resources?.items,
    prompts: prompts?.items,
    pageCounts: {
      tools: tools.pages,
      resources: resources?.pages ?? 0,
      prompts: prompts?.pages ?? 0,
    },
  };
}

/**
 * Connects, lists everything the target offers, and disconnects. No session
 * kept: Vetit is not in the live call path.
 */
export async function listTargetSurface(
  options: TargetConnectionOptions,
): Promise<TargetListing> {
  const client = new Client(CLIENT_IDENTITY);
  const transport = new StreamableClientTransport(new URL(options.url));
  try {
    await client.connect(transport);
    return await readSurface({
      client,
      requestOptions: { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    });
  } finally {
    await client.close();
  }
}
