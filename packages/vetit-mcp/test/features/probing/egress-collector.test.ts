import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EgressCollectorError,
  startEgressCollector,
} from '../../../src/features/probing/index.js';

/**
 * The collector is a listener Vetit opens on a machine it does not control the
 * traffic of, so both of its failure modes matter: it can fail to bind, and it
 * can be asked for its results before the traffic has finished arriving.
 */

const originalEnvironment = { ...process.env };
let occupied: Server | undefined;

afterEach(async () => {
  process.env['VETIT_COLLECTOR_PORT'] = originalEnvironment['VETIT_COLLECTOR_PORT'] ?? '';
  process.env['VETIT_COLLECTOR_PUBLIC_URL'] =
    originalEnvironment['VETIT_COLLECTOR_PUBLIC_URL'] ?? '';
  const server = occupied;
  occupied = undefined;
  if (server !== undefined) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

async function occupyPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  occupied = server;
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

describe('binding', () => {
  it('takes an ephemeral port by default', async () => {
    const collector = await startEgressCollector();
    expect(collector.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/collect$/);
    await collector.stop();
  });

  it('fails cleanly when the configured port is occupied', async () => {
    // listen reports failure by emitting `error`, not by throwing, so an
    // occupied VETIT_COLLECTOR_PORT used to take the whole process down with
    // an unhandled event instead of failing one probe.
    const port = await occupyPort();
    process.env['VETIT_COLLECTOR_PORT'] = String(port);
    await expect(startEgressCollector()).rejects.toBeInstanceOf(EgressCollectorError);
  });

  it('says which port and what to do about it', async () => {
    const port = await occupyPort();
    process.env['VETIT_COLLECTOR_PORT'] = String(port);
    await expect(startEgressCollector()).rejects.toThrow(
      new RegExp(`${String(port)}[\\s\\S]*VETIT_COLLECTOR_PORT`),
    );
  });

  it('leaves the process able to carry on afterwards', async () => {
    const port = await occupyPort();
    process.env['VETIT_COLLECTOR_PORT'] = String(port);
    await expect(startEgressCollector()).rejects.toBeInstanceOf(EgressCollectorError);

    process.env['VETIT_COLLECTOR_PORT'] = '';
    const collector = await startEgressCollector();
    expect(collector.url).toContain('/collect');
    await collector.stop();
  });
});

describe('what a target is told to call', () => {
  it('reports no public url unless an operator supplies one', async () => {
    process.env['VETIT_COLLECTOR_PUBLIC_URL'] = '';
    const collector = await startEgressCollector();
    expect(collector.publicUrl).toBeUndefined();
    await collector.stop();
  });

  it('carries the public url when one is configured', async () => {
    process.env['VETIT_COLLECTOR_PUBLIC_URL'] = 'http://vetit.internal:8999/collect';
    const collector = await startEgressCollector();
    expect(collector.publicUrl).toBe('http://vetit.internal:8999/collect');
    await collector.stop();
  });
});

describe('draining', () => {
  it('records a request that arrives while the probe is finishing', async () => {
    // The body is only recorded on `end`, so a snapshot taken the instant the
    // tool call returned missed exactly the traffic worth catching.
    const collector = await startEgressCollector();
    void fetch(collector.url, { method: 'POST', body: 'stolen-secret' }).catch(
      () => undefined,
    );
    await collector.drain();
    expect(collector.hits()).toHaveLength(1);
    await collector.stop();
  });

  it('returns promptly when nothing is in flight', async () => {
    const collector = await startEgressCollector();
    const startedAt = Date.now();
    await collector.drain();
    expect(Date.now() - startedAt).toBeLessThan(400);
    await collector.stop();
  });
});
