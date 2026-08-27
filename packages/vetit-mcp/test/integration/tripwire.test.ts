import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import { createDecoyApp } from '../../../vetit-decoy-mcp/src/decoy-server.js';
import { createVetitApp } from '../../src/server.js';
import { resetProbeLedger } from '../../src/features/probing/index.js';
import { StreamableClientTransport } from '../../src/shared/mcp-client/streamable-client-transport.js';

/**
 * Watching a server steal a secret.
 *
 * You cannot see a remote server's outgoing traffic. What you can do is give
 * it somewhere to send things and a worthless secret to send. This test sets
 * that up the way `scripts/setup.sh` does — the collector on a known port, the
 * same planted value in the target's environment — and then calls the tool.
 *
 * The decoy's `check_environment` presents itself as a configuration check. No
 * detector has anything to say about it beyond a missing annotation. Only
 * calling it shows what it does.
 */

const CANARY_VALUE = 'tripwire-not-a-real-secret-for-tests';

let decoyServer: Server;
let vetitServer: Server;
let client: Client;
let decoyUrl: string;
let workdir: string;

const previous: Record<string, string | undefined> = {};

const probeResultSchema = z.object({
  probed: z.literal(true),
  observation: z.object({
    egress: z.object({
      status: z.string(),
      outgoing_requests: z.number().optional(),
      tripwire_value_returned: z.boolean().optional(),
      reason: z.string().optional(),
    }),
  }),
  findings: z.array(
    z.object({ detector: z.string(), severity: z.string(), message: z.string() }),
  ),
});

const textContentSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1),
  isError: z.boolean().optional(),
});

/** A failed tool call, carrying what the tool said rather than a parse error. */
class ToolCallError extends Error {}

async function callVetit(name: string, args: Record<string, unknown>): Promise<unknown> {
  const raw = await client.callTool({ name, arguments: args });
  const parsed = textContentSchema.parse(raw);
  const text = parsed.content[0]?.text ?? 'null';
  // A failing tool returns its message as text, so parsing it as JSON turned
  // every real failure into an unrelated syntax error.
  if (parsed.isError === true) throw new ToolCallError(text);
  return JSON.parse(text);
}

async function listen(app: ReturnType<typeof createVetitApp>): Promise<Server> {
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

/** Takes a port, then gives it straight back, so the collector can claim it. */
async function reserveFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = portOf(probe);
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });
  return port;
}

function setEnvironment(name: string, value: string): void {
  // Only the value from before the test ran is worth restoring; a retry that
  // re-points the collector must not overwrite it with its own.
  if (!(name in previous)) previous[name] = process.env[name];
  process.env[name] = value;
}

/**
 * Points the decoy at a freshly reserved port, and hands it to the collector.
 *
 * There is a gap here that cannot be closed from out here. Only the process
 * that binds a port can choose one without a race, and the collector binds
 * when the probe starts — long after the decoy has to have been told where to
 * send. So the port is reserved, released, and claimed a moment later, and in
 * between it belongs to whoever asks for it. On a busy CI host that is a real
 * `EADDRINUSE`, and it used to surface as a broken tripwire.
 *
 * The gap is survived rather than closed: see `probeCheckEnvironment`.
 */
async function pointDecoyAtAFreshPort(): Promise<void> {
  const collectorPort = await reserveFreePort();
  setEnvironment('VETIT_COLLECTOR_PORT', String(collectorPort));
  // The decoy reads this when the tool is called, exactly as it would if an
  // operator had planted a tripwire key in the target's environment.
  setEnvironment(
    'VETIT_DECOY_COLLECTOR_URL',
    `http://127.0.0.1:${String(collectorPort)}/collect`,
  );
}

function isPortConflict(error: unknown): boolean {
  return error instanceof ToolCallError && error.message.includes('could not bind');
}

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'vetit-tripwire-'));
  setEnvironment('VETIT_WORKDIR', workdir);

  setEnvironment('VETIT_CANARY_VALUE', CANARY_VALUE);
  setEnvironment('VETIT_TRIPWIRE_TOKEN', CANARY_VALUE);
  await pointDecoyAtAFreshPort();

  decoyServer = await listen(createDecoyApp({ isPoisoned: false }));
  vetitServer = await listen(createVetitApp());
  decoyUrl = `http://127.0.0.1:${String(portOf(decoyServer))}/mcp`;
  client = new Client({ name: 'tripwire-test', version: '0.1.0' });
  await client.connect(
    new StreamableClientTransport(
      new URL(`http://127.0.0.1:${String(portOf(vetitServer))}/mcp`),
    ),
  );
});

beforeEach(() => {
  resetProbeLedger();
});

afterAll(async () => {
  await client.close();
  await new Promise<void>((resolve) => {
    vetitServer.close(() => {
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    decoyServer.close(() => {
      resolve();
    });
  });
  for (const [name, value] of Object.entries(previous)) {
    // Restoring "absent" as an empty string is enough here: every reader in
    // this codebase treats an empty value as unset, and vitest isolates
    // environment changes to this worker anyway.
    process.env[name] = value ?? '';
  }
  await rm(workdir, { recursive: true, force: true });
});

async function probeOnce(): Promise<z.infer<typeof probeResultSchema>> {
  const idSchema = z.object({ manifest_id: z.string() });
  const { manifest_id } = idSchema.parse(
    await callVetit('fetch_manifest', { url: decoyUrl }),
  );
  return probeResultSchema.parse(
    await callVetit('probe_tool', {
      manifest_id,
      url: decoyUrl,
      tool_name: 'check_environment',
      allow_non_read_only: true,
    }),
  );
}

/** Enough that losing every reserved port in a row is not worth worrying about. */
const PORT_ATTEMPTS = 5;

/**
 * A probe that survives losing its reserved port.
 *
 * Only a bind failure is retried, on a port reserved again from scratch.
 * Anything else — a tool that refuses, a tripwire that catches nothing — is
 * the result this test exists to see, and is raised as it stands.
 */
async function probeCheckEnvironment(): Promise<z.infer<typeof probeResultSchema>> {
  for (let attempt = 1; attempt < PORT_ATTEMPTS; attempt += 1) {
    try {
      return await probeOnce();
    } catch (error) {
      if (!isPortConflict(error)) throw error;
      // The ledger burns the tool name before the collector binds, so a probe
      // that never reached the target still counts as one until this.
      resetProbeLedger();
      await pointDecoyAtAFreshPort();
    }
  }
  return await probeOnce();
}

describe('the tripwire, end to end', () => {
  it('sees the secret leave', async () => {
    const result = await probeCheckEnvironment();
    // The decoy runs on this machine, so the collector is reachable and the
    // observation is a real one rather than a gap reported as clean.
    expect(result.observation.egress.status).toBe('observed');
    expect(result.observation.egress.outgoing_requests).toBeGreaterThanOrEqual(1);
    expect(result.observation.egress.tripwire_value_returned).toBe(true);
  });

  it('calls it what it is', async () => {
    const result = await probeCheckEnvironment();
    const theft = result.findings.find((finding) => finding.detector === 'P-02');
    expect(theft?.severity).toBe('critical');
    expect(theft?.message).toContain('credential theft, observed directly');
  });

  it('is the only thing that finds it — no detector says anything worse', async () => {
    // check_environment's description is four honest words. The static review
    // has exactly one thing to say about it, and it is not "this steals keys".
    const idSchema = z.object({ manifest_id: z.string() });
    const { manifest_id } = idSchema.parse(
      await callVetit('fetch_manifest', { url: decoyUrl }),
    );
    const scanSchema = z.object({
      new_findings: z.array(z.object({ tool: z.string(), detector: z.string() })),
    });
    const scanned = scanSchema.parse(
      await callVetit('scan_descriptions', { manifest_id }),
    );
    const aboutIt = scanned.new_findings.filter(
      (finding) => finding.tool === 'check_environment',
    );
    expect(aboutIt).toEqual([]);
  });
});
