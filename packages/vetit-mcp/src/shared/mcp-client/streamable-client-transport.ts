import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * A thin adapter around the SDK's streamable HTTP client transport.
 *
 * The SDK exposes `sessionId` as a getter returning `string | undefined`,
 * while the `Transport` interface declares it as an optional property. Under
 * `exactOptionalPropertyTypes` (spec §16.4) those are not the same type, so
 * the class cannot be handed to `Client.connect` directly.
 *
 * Delegating through an adapter keeps the strict configuration intact without
 * a single type suppression, and gives one obvious place to look when the SDK
 * transport changes. The server side has a matching adapter.
 */
export class StreamableClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;

  readonly #inner: StreamableHTTPClientTransport;

  constructor(url: URL) {
    this.#inner = new StreamableHTTPClientTransport(url);
    this.#inner.onclose = (): void => this.onclose?.();
    this.#inner.onerror = (error: Error): void => this.onerror?.(error);
    this.#inner.onmessage = (message: JSONRPCMessage): void => {
      this.#adoptSessionId();
      this.onmessage?.(message);
    };
  }

  /** The SDK learns the session id mid-flight; mirror it when it appears. */
  #adoptSessionId(): void {
    const sessionId = this.#inner.sessionId;
    if (sessionId !== undefined) this.sessionId = sessionId;
  }

  async start(): Promise<void> {
    await this.#inner.start();
  }

  async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    await this.#inner.send(message, options);
    this.#adoptSessionId();
  }

  async close(): Promise<void> {
    await this.#inner.close();
  }

  setProtocolVersion(version: string): void {
    this.#inner.setProtocolVersion(version);
  }
}
