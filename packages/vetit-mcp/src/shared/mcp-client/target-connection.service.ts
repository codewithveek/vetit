import { Client } from '@modelcontextprotocol/sdk/client/index.js';
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

export interface TargetConnectionOptions {
  readonly url: string;
  readonly timeoutMs?: number;
}

export interface TargetListing {
  readonly serverInfo: unknown;
  readonly capabilities: unknown;
  readonly tools: unknown;
  readonly resources: unknown;
  readonly prompts: unknown;
}

async function listIfSupported(
  list: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await list();
  } catch {
    // A server that does not implement resources/list or prompts/list is not
    // a finding. Recording "absent" is honest; inventing an empty list is not.
    return undefined;
  }
}

/**
 * Connects, lists everything the target offers, and disconnects. One
 * round trip, no session kept: Vetit is not in the live call path.
 */
export async function listTargetSurface(
  options: TargetConnectionOptions,
): Promise<TargetListing> {
  const client = new Client(CLIENT_IDENTITY);
  const transport = new StreamableClientTransport(new URL(options.url));
  const requestOptions = { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS };
  try {
    await client.connect(transport);
    const tools = await client.listTools(undefined, requestOptions);
    const resources = await listIfSupported(() =>
      client.listResources(undefined, requestOptions),
    );
    const prompts = await listIfSupported(() =>
      client.listPrompts(undefined, requestOptions),
    );
    return {
      serverInfo: client.getServerVersion(),
      capabilities: client.getServerCapabilities(),
      tools,
      resources,
      prompts,
    };
  } finally {
    await client.close();
  }
}
