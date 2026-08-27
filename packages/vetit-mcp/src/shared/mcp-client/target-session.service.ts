import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableClientTransport } from './streamable-client-transport.js';

/**
 * A short session with a server we do not trust.
 *
 * Probing needs several calls in a row — read the state, call the tool, read
 * the state again — and they have to happen on one connection or the
 * comparison means nothing. This opens exactly one, hands over a deliberately
 * tiny surface, and closes it whatever happens.
 *
 * Everything returned is `unknown`. The target decides what comes back.
 */

const CLIENT_IDENTITY = { name: 'vetit-probe', version: '0.1.0' } as const;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface TargetSession {
  callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export interface TargetSessionOptions {
  readonly url: string;
  readonly timeoutMs?: number;
}

export async function withTargetSession<TResult>(
  options: TargetSessionOptions,
  use: (session: TargetSession) => Promise<TResult>,
): Promise<TResult> {
  const client = new Client(CLIENT_IDENTITY);
  const transport = new StreamableClientTransport(new URL(options.url));
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    await client.connect(transport);
    return await use({
      callTool: async (name, args) =>
        await client.callTool({ name, arguments: { ...args } }, undefined, { timeout }),
    });
  } finally {
    await client.close();
  }
}
