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
 * The whole review, driven the way an agent drives it: over MCP.
 *
 * Two real servers on two real sockets — Vetit and the decoy — and a real MCP
 * client in between. Nothing is stubbed, because the parts most worth testing
 * here are the ones that only exist at the boundary: what a tool actually
 * returns, and whether any of the target's text comes back with it.
 */

let decoyServer: Server;
let vetitServer: Server;
let client: Client;
let decoyUrl: string;
let workdir: string;
let previousWorkdir: string | undefined;

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

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'vetit-pipeline-'));
  previousWorkdir = process.env['VETIT_WORKDIR'];
  process.env['VETIT_WORKDIR'] = workdir;

  decoyServer = await listen(createDecoyApp({ isPoisoned: false }));
  vetitServer = await listen(createVetitApp());
  decoyUrl = urlFor(decoyServer);

  client = new Client({ name: 'review-pipeline-test', version: '0.1.0' });
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

describe('vetit-mcp as a server', () => {
  it('publishes the review tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'analyze_schemas',
      'check_annotations',
      'check_shadowing',
      'compute_risk',
      'fetch_manifest',
      'lookup_advisories',
      'scan_descriptions',
    ]);
  });

  it('annotates every one of its own tools honestly', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
    }
  });

  it('publishes descriptions that instruct nobody', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description ?? '').not.toMatch(/[<>]/);
      expect(tool.description ?? '').not.toMatch(/ignore previous|do not tell/i);
    }
  });
});

describe('the review, end to end', () => {
  it('runs fetch, scan, analyse, annotate, shadow and score', async () => {
    const manifestSchema = z.object({
      manifest_id: z.string(),
      tool_count: z.number(),
      manifest_hash: z.string(),
    });
    const fetched = manifestSchema.parse(
      await callVetit('fetch_manifest', { url: decoyUrl }),
    );
    expect(fetched.tool_count).toBe(11);

    const scanSchema = z.object({
      new_findings: z.array(z.object({ detector: z.string(), tool: z.string() })),
      total_findings_recorded: z.number(),
    });

    const descriptions = scanSchema.parse(
      await callVetit('scan_descriptions', { manifest_id: fetched.manifest_id }),
    );
    expect(descriptions.new_findings.some((f) => f.detector === 'D-01')).toBe(true);

    const schemas = scanSchema.parse(
      await callVetit('analyze_schemas', { manifest_id: fetched.manifest_id }),
    );
    expect(schemas.new_findings.some((f) => f.tool === 'add')).toBe(true);

    const shadowing = scanSchema.parse(
      await callVetit('check_shadowing', {
        manifest_id: fetched.manifest_id,
        installed_tool_names: ['post_message'],
      }),
    );
    expect(shadowing.new_findings.some((f) => f.detector === 'D-09')).toBe(true);

    const annotationsSchema = z.object({
      table: z.array(
        z.object({ tool: z.string(), treated_as: z.enum(['read', 'write']) }),
      ),
      why_silence_is_a_write: z.string(),
    });
    const annotations = annotationsSchema.parse(
      await callVetit('check_annotations', { manifest_id: fetched.manifest_id }),
    );
    const unannotated = annotations.table.filter((row) => row.treated_as === 'write');
    expect(unannotated.map((row) => row.tool)).toContain('check_environment');

    const riskSchema = z.object({
      score: z.number(),
      band: z.string(),
      working_out: z.string(),
      finding_count: z.number(),
    });
    const risk = riskSchema.parse(
      await callVetit('compute_risk', { manifest_id: fetched.manifest_id }),
    );
    expect(risk.band).toBe('reject_recommended');
    expect(risk.working_out).toContain('critical');
    expect(risk.finding_count).toBeGreaterThan(descriptions.new_findings.length);
  });

  it('accumulates findings across scans rather than replacing them', async () => {
    const idSchema = z.object({ manifest_id: z.string() });
    const { manifest_id } = idSchema.parse(
      await callVetit('fetch_manifest', { url: decoyUrl }),
    );
    const countSchema = z.object({ total_findings_recorded: z.number() });

    const afterDescriptions = countSchema.parse(
      await callVetit('scan_descriptions', { manifest_id }),
    );
    const afterSchemas = countSchema.parse(
      await callVetit('analyze_schemas', { manifest_id }),
    );
    expect(afterSchemas.total_findings_recorded).toBeGreaterThan(
      afterDescriptions.total_findings_recorded,
    );
  });

  it('says plainly that a score of zero means nothing was checked', async () => {
    const idSchema = z.object({ manifest_id: z.string() });
    const { manifest_id } = idSchema.parse(
      await callVetit('fetch_manifest', { url: decoyUrl }),
    );
    const noteSchema = z.object({ score: z.number(), note: z.string() });
    const risk = noteSchema.parse(await callVetit('compute_risk', { manifest_id }));
    expect(risk.score).toBe(0);
    expect(risk.note).toContain('nothing was checked');
  });
});

describe('what never comes back', () => {
  it('returns no unwrapped text the decoy wrote', async () => {
    const idSchema = z.object({ manifest_id: z.string() });
    const { manifest_id } = idSchema.parse(
      await callVetit('fetch_manifest', { url: decoyUrl }),
    );
    const scanned = JSON.stringify(await callVetit('scan_descriptions', { manifest_id }));

    // The evidence is present, but only ever inside a cleaned snippet.
    expect(scanned).toContain('UNTRUSTED_TEXT');
    expect(scanned).not.toContain('<IMPORTANT>');
    expect(scanned).not.toContain('<!--');
  });

  it('makes the homoglyph in a tool name visible rather than passing it through', async () => {
    const idSchema = z.object({ manifest_id: z.string() });
    const { manifest_id } = idSchema.parse(
      await callVetit('fetch_manifest', { url: decoyUrl }),
    );
    const annotations = JSON.stringify(
      await callVetit('check_annotations', { manifest_id }),
    );
    expect(annotations).toContain('sendm');
  });
});

describe('lookup_advisories', () => {
  it('returns searches to run, never an advisory it made up', async () => {
    const schema = z.object({
      advisories: z.array(z.unknown()),
      performed: z.boolean(),
      suggested_searches: z.array(z.string()).min(1),
    });
    const result = schema.parse(
      await callVetit('lookup_advisories', { identifier: 'postmark-mcp' }),
    );
    expect(result.advisories).toEqual([]);
    expect(result.performed).toBe(false);
    expect(result.suggested_searches.some((s) => s.includes('CVE'))).toBe(true);
  });
});
