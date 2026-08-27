import { createServer, type Server } from 'node:http';
import { cleanUntrustedSnippet } from '../../shared/redaction/index.js';
import type { EgressHit } from './probing.types.js';

/**
 * The tripwire.
 *
 * You cannot watch a remote server's outgoing traffic from outside it. What
 * you *can* do is give it somewhere to send things and see whether it does.
 * So Vetit starts a listener it controls, plants a worthless-but-recognisable
 * secret where a thief would look, and records anything that arrives.
 *
 * Nothing arriving is not proof of innocence, and the report says so. Something
 * arriving is proof of guilt, and no amount of description reading produces it.
 *
 * Configuration, all optional:
 *
 *   VETIT_COLLECTOR_PORT        bind a known port, so a target can be pointed
 *                               at it before it starts
 *   VETIT_COLLECTOR_HOST        bind address. Defaults to loopback
 *   VETIT_COLLECTOR_PUBLIC_URL  the URL a *target* can reach this on. Needed
 *                               before egress can be observed on any target
 *                               that is not on this machine
 *   VETIT_CANARY_VALUE          use a known tripwire value, so the same
 *                               worthless secret can be planted in the
 *                               target's environment
 */

const DEFAULT_HOST = '127.0.0.1';
const DRAIN_TIMEOUT_MS = 750;
const DRAIN_POLL_MS = 25;
/** Long enough for a loopback request already sent to arrive. */
const SETTLE_MS = 120;

export interface EgressCollector {
  /** Where this collector actually listens. */
  readonly url: string;
  /** What a target could reach, if an operator has said so. */
  readonly publicUrl: string | undefined;
  readonly canaryValue: string;
  hits(): readonly EgressHit[];
  /** Waits for in-flight requests to finish, bounded. */
  drain(): Promise<void>;
  stop(): Promise<void>;
}

export class EgressCollectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EgressCollectorError';
  }
}

/** Recognisable on sight, worth nothing, and obviously not a real secret. */
function mintCanaryValue(): string {
  const configured = process.env['VETIT_CANARY_VALUE'];
  if (configured !== undefined && configured.length > 0) return configured;
  const nonce = Math.floor(Math.random() * 0xff_ff_ff_ff)
    .toString(16)
    .padStart(8, '0');
  return `vetit-canary-not-a-real-secret-${nonce}`;
}

function readBody(request: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk: Buffer | string) => {
      if (body.length < 8192) body += String(chunk);
    });
    request.on('end', () => {
      resolve(body);
    });
    request.on('error', () => {
      resolve(body);
    });
  });
}

interface IncomingRequestRecord {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

function buildHitRecorder(
  hits: EgressHit[],
  canaryValue: string,
): (record: IncomingRequestRecord) => void {
  return (record) => {
    hits.push({
      method: record.method,
      path: record.path,
      bodySnippet: cleanUntrustedSnippet({ text: record.body }).renderedText,
      containedCanary: record.body.includes(canaryValue),
    });
  };
}

function resolveCollectorPort(): number {
  const configured = Number.parseInt(process.env['VETIT_COLLECTOR_PORT'] ?? '', 10);
  return Number.isInteger(configured) && configured >= 0 ? configured : 0;
}

function resolveCollectorHost(): string {
  const configured = process.env['VETIT_COLLECTOR_HOST'];
  return configured !== undefined && configured.length > 0 ? configured : DEFAULT_HOST;
}

interface ListenOptions {
  readonly server: Server;
  readonly port: number;
  readonly host: string;
}

/**
 * Binding, with the failure handled.
 *
 * `listen` reports failure by emitting `error`, not by throwing, so waiting
 * only on the callback left an unhandled error event — an occupied
 * `VETIT_COLLECTOR_PORT` took the whole Vetit process down instead of failing
 * one probe. The listener is one-shot and removed on success so it cannot
 * later intercept an unrelated error.
 */
async function listenOrFail(options: ListenOptions): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      options.server.close();
      reject(
        new EgressCollectorError(
          `The tripwire collector could not bind ${options.host}:` +
            `${String(options.port)} — ${error.message}. Set ` +
            'VETIT_COLLECTOR_PORT to a free port, or unset it to take any.',
        ),
      );
    };
    options.server.once('error', onError);
    options.server.listen(options.port, options.host, () => {
      options.server.removeListener('error', onError);
      resolve();
    });
  });
}

/**
 * A fire-and-forget POST can still be arriving when the tool call returns —
 * the body is only recorded on `end` — so a snapshot taken immediately missed
 * exactly the traffic worth catching. Bounded, because a hostile target that
 * never closes a request must not be able to hold a probe open.
 */
function buildDrain(countPending: () => number): () => Promise<void> {
  return async () => {
    // The settle comes first, and that ordering is the whole point. Waiting on
    // the in-flight counter alone catches nothing: a request still crossing
    // the network has not reached the handler yet, so the counter reads zero
    // and the wait returns immediately — which is exactly how the traffic
    // worth catching was being missed.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (countPending() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    }
  };
}

export async function startEgressCollector(): Promise<EgressCollector> {
  const canaryValue = mintCanaryValue();
  const hits: EgressHit[] = [];
  const record = buildHitRecorder(hits, canaryValue);
  let pending = 0;

  const server: Server = createServer((request, response) => {
    pending += 1;
    void readBody(request).then((body) => {
      record({ method: request.method ?? 'GET', path: request.url ?? '/', body });
      pending -= 1;
      response.writeHead(204).end();
    });
  });

  const host = resolveCollectorHost();
  await listenOrFail({ server, port: resolveCollectorPort(), host });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new EgressCollectorError('The tripwire collector bound no usable port.');
  }

  const configuredPublicUrl = process.env['VETIT_COLLECTOR_PUBLIC_URL'];
  return {
    url: `http://${host}:${String(address.port)}/collect`,
    publicUrl:
      configuredPublicUrl !== undefined && configuredPublicUrl.length > 0
        ? configuredPublicUrl
        : undefined,
    canaryValue,
    hits: () => [...hits],
    drain: buildDrain(() => pending),
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
