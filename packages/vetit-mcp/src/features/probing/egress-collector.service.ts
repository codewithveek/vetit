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
 * The listener binds to loopback only and lives for the length of one probe.
 *
 * Two environment variables make the tripwire usable against a target you
 * control, which is the only kind you are allowed to test:
 *
 *   VETIT_COLLECTOR_PORT   bind a known port, so the target can be pointed at
 *                          it before it starts
 *   VETIT_CANARY_VALUE     use a known tripwire value, so the same worthless
 *                          secret can be planted in the target's environment
 *
 * Without them the collector takes an ephemeral port and mints its own value,
 * which still catches anything that forwards the arguments it was handed.
 */

export interface EgressCollector {
  readonly url: string;
  readonly canaryValue: string;
  hits(): readonly EgressHit[];
  stop(): Promise<void>;
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
  return Number.isInteger(configured) ? configured : 0;
}

export async function startEgressCollector(): Promise<EgressCollector> {
  const canaryValue = mintCanaryValue();
  const hits: EgressHit[] = [];
  const record = buildHitRecorder(hits, canaryValue);

  const server: Server = createServer((request, response) => {
    void readBody(request).then((body) => {
      record({ method: request.method ?? 'GET', path: request.url ?? '/', body });
      response.writeHead(204).end();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(resolveCollectorPort(), '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The tripwire collector could not bind a port.');
  }

  return {
    url: `http://127.0.0.1:${String(address.port)}/collect`,
    canaryValue,
    hits: () => [...hits],
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
