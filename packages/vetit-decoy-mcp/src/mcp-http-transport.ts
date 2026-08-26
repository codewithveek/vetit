import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  JSONRPCMessage,
  MessageExtraInfo,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * A thin adapter around the SDK's streamable HTTP transport.
 *
 * The SDK declares its callback properties as `(() => void) | undefined` while
 * the `Transport` interface declares them optional. Under
 * `exactOptionalPropertyTypes` (spec §16.4) those two shapes are not
 * assignable, so the class cannot be handed to `Server.connect` directly.
 *
 * Delegating through an adapter that declares the callbacks the way the
 * interface does keeps the strict configuration intact and costs no
 * suppressions. It also gives us one obvious place to look when the SDK
 * transport changes.
 *
 * Stateless: no `sessionIdGenerator` is supplied, which is how the SDK asks
 * for one transport per request.
 */
export class StatelessHttpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  readonly #inner = new StreamableHTTPServerTransport({});

  constructor() {
    this.#inner.onclose = (): void => this.onclose?.();
    this.#inner.onerror = (error: Error): void => this.onerror?.(error);
    this.#inner.onmessage = (
      message: JSONRPCMessage,
      extra?: MessageExtraInfo,
    ): void => this.onmessage?.(message, extra);
  }

  async start(): Promise<void> {
    await this.#inner.start();
  }

  async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    await this.#inner.send(message, options);
  }

  async close(): Promise<void> {
    await this.#inner.close();
  }

  async handleRequest(
    exchange: { readonly request: IncomingMessage; readonly response: ServerResponse },
    parsedBody: unknown,
  ): Promise<void> {
    await this.#inner.handleRequest(exchange.request, exchange.response, parsedBody);
  }
}
