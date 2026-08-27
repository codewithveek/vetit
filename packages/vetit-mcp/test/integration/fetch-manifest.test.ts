import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
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

  it('keeps every field the target sent, not just the ones it expected', async () => {
    // The schemas used to drop unknown keys before writing, so the file called
    // the raw manifest was a filtered view of it. A field nobody expected is
    // interesting precisely because nobody expected it.
    const summary = await fetchManifest({ url: baseUrl, connectorName: undefined });
    const stored: unknown = JSON.parse(await readFile(summary.path, 'utf8'));
    const parsed = z
      .object({
        raw: z.object({
          tools: z.array(z.unknown()),
          pageCounts: z.object({ tools: z.number() }),
        }),
        tools: z.array(z.object({ name: z.string() }).passthrough()),
      })
      .parse(stored);

    expect(parsed.raw.tools).toHaveLength(11);
    expect(parsed.raw.pageCounts.tools).toBe(1);
    // The decoy annotates and describes; both survive into the validated view.
    const add = parsed.tools.find((tool) => tool.name === 'add');
    expect(add).toHaveProperty('inputSchema');
    expect(add).toHaveProperty('annotations');
  });

  it('reports how the listings ended rather than implying emptiness', async () => {
    const summary = await fetchManifest({ url: baseUrl, connectorName: undefined });
    // The decoy implements neither resources nor prompts. That is an absence
    // the server declared, and it is recorded as one.
    expect(summary.resources_status).toBe('unsupported');
    expect(summary.prompts_status).toBe('unsupported');
    expect(summary.resource_count).toBe(0);
  });

  it('reports nothing unparseable and no duplicate names for a well-formed target', async () => {
    const summary = await fetchManifest({ url: baseUrl, connectorName: undefined });
    expect(summary.unparseable_tool_count).toBe(0);
    expect(summary.duplicate_tool_names).toEqual([]);
    expect(summary.pages_fetched.tools).toBe(1);
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
