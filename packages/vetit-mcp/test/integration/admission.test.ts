import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import { createDecoyApp } from '../../../vetit-decoy-mcp/src/decoy-server.js';
import { createVetitApp } from '../../src/server.js';
import { StreamableClientTransport } from '../../src/shared/mcp-client/streamable-client-transport.js';

/**
 * What Vetit would actually propose for the decoy.
 *
 * `apply: false` means the whole flow runs without a TrueForge instance and
 * without changing anything, which is also the right default for a tool that
 * decides what an agent is allowed to do.
 */

let decoyServer: Server;
let vetitServer: Server;
let client: Client;
let workdir: string;
let previousWorkdir: string | undefined;

const grantSchema = z.object({
  applied: z.literal(false),
  grant: z.object({
    name: z.string(),
    decision: z.enum(['reject', 'admit_reduced', 'admit_full']),
    enable_tools: z.array(z.string()),
    disable_tools: z.array(z.string()),
    require_approval_for_tools: z.array(z.string()),
    preload: z.boolean(),
    why: z.record(z.string()),
    not_covered: z.array(z.string()),
  }),
});

const textContentSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1),
});

async function callVetit(name: string, args: Record<string, unknown>): Promise<unknown> {
  const raw = await client.callTool({ name, arguments: args });
  const parsed = textContentSchema.parse(raw);
  return JSON.parse(parsed.content[0]?.text ?? 'null');
}

async function listen(app: ReturnType<typeof createVetitApp>): Promise<Server> {
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

function urlFor(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${String(address.port)}/mcp`;
}

async function reviewDecoy(decoyUrl: string): Promise<string> {
  const idSchema = z.object({ manifest_id: z.string() });
  const { manifest_id } = idSchema.parse(
    await callVetit('fetch_manifest', { url: decoyUrl }),
  );
  await callVetit('scan_descriptions', { manifest_id });
  await callVetit('analyze_schemas', { manifest_id });
  await callVetit('check_annotations', { manifest_id });
  await callVetit('check_shadowing', { manifest_id, installed_tool_names: [] });
  return manifest_id;
}

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'vetit-admission-'));
  previousWorkdir = process.env['VETIT_WORKDIR'];
  process.env['VETIT_WORKDIR'] = workdir;

  decoyServer = await listen(createDecoyApp({ isPoisoned: false }));
  vetitServer = await listen(createVetitApp());
  client = new Client({ name: 'admission-test', version: '0.1.0' });
  await client.connect(new StreamableClientTransport(new URL(urlFor(vetitServer))));
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
  if (previousWorkdir === undefined) delete process.env['VETIT_WORKDIR'];
  else process.env['VETIT_WORKDIR'] = previousWorkdir;
  await rm(workdir, { recursive: true, force: true });
});

describe('the grant Vetit proposes for the decoy', () => {
  it('rejects it, and says so with every tool switched off', async () => {
    const manifestId = await reviewDecoy(urlFor(decoyServer));
    const proposal = grantSchema.parse(
      await callVetit('write_admission', {
        manifest_id: manifestId,
        connector_name: 'decoy',
        not_covered: ['Behavioural verification: NOT PERFORMED — no credential supplied'],
        apply: false,
      }),
    );
    expect(proposal.grant.decision).toBe('reject');
    expect(proposal.grant.disable_tools).toEqual(['@all']);
    expect(proposal.grant.enable_tools).toEqual([]);
  });

  it('cites a finding id against every tool it restricted', async () => {
    const manifestId = await reviewDecoy(urlFor(decoyServer));
    const proposal = grantSchema.parse(
      await callVetit('write_admission', {
        manifest_id: manifestId,
        connector_name: 'decoy',
        apply: false,
      }),
    );
    const reasons = Object.values(proposal.grant.why);
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      expect(reason).toMatch(/F-\d{3} —|Declares itself a write/);
    }
  });

  it('records what the review did not cover rather than implying a pass', async () => {
    const manifestId = await reviewDecoy(urlFor(decoyServer));
    const proposal = grantSchema.parse(
      await callVetit('write_admission', {
        manifest_id: manifestId,
        connector_name: 'decoy',
        not_covered: ['Behavioural verification: NOT PERFORMED — no credential supplied'],
        apply: false,
      }),
    );
    expect(proposal.grant.not_covered[0]).toContain('NOT PERFORMED');
  });

  it('changes nothing unless it is asked to', async () => {
    const manifestId = await reviewDecoy(urlFor(decoyServer));
    const proposal = grantSchema.parse(
      await callVetit('write_admission', {
        manifest_id: manifestId,
        connector_name: 'decoy',
        apply: false,
      }),
    );
    expect(proposal.applied).toBe(false);
  });
});

describe('vetit-mcp labels its own writes', () => {
  it('annotates quarantine_server and write_admission as writes', async () => {
    const { tools } = await client.listTools();
    const quarantine = tools.find((tool) => tool.name === 'quarantine_server');
    const admission = tools.find((tool) => tool.name === 'write_admission');
    expect(quarantine?.annotations?.readOnlyHint).toBe(false);
    expect(admission?.annotations?.readOnlyHint).toBe(false);
    expect(admission?.annotations?.destructiveHint).toBe(true);
  });
});
