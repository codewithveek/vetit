import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDecoyApp } from '../../../vetit-decoy-mcp/src/decoy-server.js';
import { fetchManifest } from '../../src/features/manifest/index.js';

/**
 * End to end against vetit-decoy-mcp, and nothing else (hackathon rule 7).
 *
 * This is the test that proves fetch_manifest speaks real MCP over a real
 * socket, and — more importantly — that what comes back to the agent contains
 * none of the hostile text the decoy published.
 */

let server: Server;
let baseUrl: string;
let workdir: string;
let previousWorkdir: string | undefined;

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'vetit-test-'));
  previousWorkdir = process.env['VETIT_WORKDIR'];
  process.env['VETIT_WORKDIR'] = workdir;

  server = createServer(createDecoyApp({ isPoisoned: false }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${String(address.port)}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  if (previousWorkdir === undefined) delete process.env['VETIT_WORKDIR'];
  else process.env['VETIT_WORKDIR'] = previousWorkdir;
  await rm(workdir, { recursive: true, force: true });
});

describe('fetch_manifest against the decoy', () => {
  it('lists every tool the decoy publishes', async () => {
    const summary = await fetchManifest({ url: baseUrl, connectorName: undefined });
    expect(summary.tool_count).toBe(11);
    expect(Object.keys(summary.per_tool_hashes)).toHaveLength(11);
  });

  it('returns nothing the decoy wrote', async () => {
    const summary = await fetchManifest({ url: baseUrl, connectorName: undefined });
    const returned = JSON.stringify(summary);
    for (const hostileFragment of [
      'IMPORTANT',
      'id_rsa',
      'sidenote',
      'github.create_issue',
      'telemetry.decoy-collector',
    ]) {
      expect(returned).not.toContain(hostileFragment);
    }
  });

  it('writes the raw manifest to a file the reader can open', async () => {
    const summary = await fetchManifest({ url: baseUrl, connectorName: undefined });
    const onDisk = await readFile(summary.path, 'utf8');
    expect(onDisk).toContain('<IMPORTANT>');
    expect(summary.path.startsWith(workdir)).toBe(true);
  });

  it('gives the same hash for the same server twice running', async () => {
    const first = await fetchManifest({ url: baseUrl, connectorName: undefined });
    const second = await fetchManifest({ url: baseUrl, connectorName: undefined });
    expect(second.manifest_hash).toBe(first.manifest_hash);
    expect(second.manifest_id).not.toBe(first.manifest_id);
  });

  it('refuses to guess when given neither a url nor a connector', async () => {
    await expect(
      fetchManifest({ url: undefined, connectorName: undefined }),
    ).rejects.toThrow(/url or a connector_name/);
  });
});

describe('fetch_manifest against the rug-pulled decoy', () => {
  it('produces a different hash after the manifest changes', async () => {
    const baseline = await fetchManifest({ url: baseUrl, connectorName: undefined });

    const poisonedServer = createServer(createDecoyApp({ isPoisoned: true }));
    await new Promise<void>((resolve) =>
      poisonedServer.listen(0, '127.0.0.1', resolve),
    );
    const address = poisonedServer.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const poisoned = await fetchManifest({
      url: `http://127.0.0.1:${String(address.port)}/mcp`,
      connectorName: undefined,
    });
    await new Promise<void>((resolve) => poisonedServer.close(() => { resolve(); }));

    expect(poisoned.manifest_hash).not.toBe(baseline.manifest_hash);
    expect(poisoned.per_tool_hashes['get_page']).toBe(
      baseline.per_tool_hashes['get_page'],
    );
    expect(poisoned.per_tool_hashes['search_docs']).not.toBe(
      baseline.per_tool_hashes['search_docs'],
    );
  });
});
