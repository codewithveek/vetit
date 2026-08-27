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
 * The moment the demo turns on.
 *
 * `export_all` is annotated `readOnlyHint: true`. Its name is unremarkable,
 * its description is honest, its schema is clean, and every detector in §8
 * passes it — there is a test in detect-decoy.test.ts asserting exactly that.
 * The only way to find out that it writes is to call it.
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

const probeResultSchema = z.object({
  probed: z.boolean(),
  refused: z.string().optional(),
  observation: z
    .object({
      tool: z.string(),
      url: z.string(),
      claimed: z.object({ read_only: z.boolean().nullable() }),
      observed: z.object({
        wrote: z.boolean(),
        how: z.array(z.string()),
        indications: z.array(z.string()),
      }),
      read_back: z.object({
        tool: z.string().nullable(),
        before: z.string(),
        after: z.string(),
        comparable: z.boolean(),
      }),
      egress: z.object({
        status: z.string(),
        outgoing_requests: z.number().optional(),
        tripwire_value_returned: z.boolean().optional(),
        reason: z.string().optional(),
      }),
      arguments_sent: z.record(z.unknown()),
      caveat: z.string(),
    })
    .optional(),
  findings: z
    .array(z.object({ detector: z.string(), severity: z.string(), message: z.string() }))
    .optional(),
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

async function fetchDecoyManifest(): Promise<string> {
  const idSchema = z.object({ manifest_id: z.string() });
  return idSchema.parse(await callVetit('fetch_manifest', { url: decoyUrl })).manifest_id;
}

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'vetit-probe-'));
  previousWorkdir = process.env['VETIT_WORKDIR'];
  process.env['VETIT_WORKDIR'] = workdir;

  decoyServer = await listen(createDecoyApp({ isPoisoned: false }));
  vetitServer = await listen(createVetitApp());
  decoyUrl = urlFor(decoyServer);
  client = new Client({ name: 'probe-test', version: '0.1.0' });
  await client.connect(new StreamableClientTransport(new URL(urlFor(vetitServer))));
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
  if (previousWorkdir === undefined) delete process.env['VETIT_WORKDIR'];
  else process.env['VETIT_WORKDIR'] = previousWorkdir;
  await rm(workdir, { recursive: true, force: true });
});

describe('probing export_all', () => {
  it('catches the lie that every static check missed', async () => {
    // list_spaces is nominated as the reader: it is read-only, takes no
    // arguments, and reports the spaces export_all adds to. Vetit will not
    // guess that relationship — an operator asserts it.
    const manifestId = await fetchDecoyManifest();
    const result = probeResultSchema.parse(
      await callVetit('probe_tool', {
        manifest_id: manifestId,
        url: decoyUrl,
        tool_name: 'export_all',
        read_back_tool: 'list_spaces',
      }),
    );

    expect(result.probed).toBe(true);
    expect(result.observation?.claimed.read_only).toBe(true);
    expect(result.observation?.observed.wrote).toBe(true);
    expect(result.observation?.read_back.comparable).toBe(true);
    expect(result.observation?.observed.how[0]).toContain('changed across the call');

    const lie = result.findings?.find((finding) => finding.detector === 'P-01');
    expect(lie?.severity).toBe('critical');
    expect(lie?.message).toContain('The label is false');
  });

  it('proves nothing without a nominated reader, and says so', async () => {
    // The old behaviour picked a reader automatically and called the result
    // proof. Nothing established that the reader observed this tool's state,
    // so the finding is now an indication at medium rather than a critical.
    const manifestId = await fetchDecoyManifest();
    const result = probeResultSchema.parse(
      await callVetit('probe_tool', {
        manifest_id: manifestId,
        url: decoyUrl,
        tool_name: 'export_all',
      }),
    );

    expect(result.observation?.observed.wrote).toBe(false);
    expect(result.observation?.read_back.comparable).toBe(false);
    expect(result.observation?.caveat).toContain('read_back_tool');
    expect(result.findings?.map((finding) => finding.detector)).toEqual(['P-05']);
    expect(result.findings?.[0]?.severity).toBe('medium');
  });

  it('names the reader it used, rather than claiming certainty it lacks', async () => {
    const manifestId = await fetchDecoyManifest();
    const result = probeResultSchema.parse(
      await callVetit('probe_tool', {
        manifest_id: manifestId,
        url: decoyUrl,
        tool_name: 'export_all',
        read_back_tool: 'list_spaces',
      }),
    );
    expect(result.observation?.read_back.tool).toBe('list_spaces');
    expect(result.observation?.caveat).toContain('list_spaces');
  });

  it('feeds the proven finding into the score, which rejects on behaviour too', async () => {
    const manifestId = await fetchDecoyManifest();
    await callVetit('probe_tool', {
      manifest_id: manifestId,
      url: decoyUrl,
      tool_name: 'export_all',
      read_back_tool: 'list_spaces',
    });
    const riskSchema = z.object({
      band: z.string(),
      counts: z.object({ critical: z.number() }),
    });
    const risk = riskSchema.parse(await callVetit('compute_risk', { manifest_id: manifestId }));
    expect(risk.counts.critical).toBeGreaterThanOrEqual(1);
    expect(risk.band).toBe('reject_recommended');
  });
});

describe('probing an honest tool', () => {
  it('finds nothing wrong with search_docs', async () => {
    const manifestId = await fetchDecoyManifest();
    const result = probeResultSchema.parse(
      await callVetit('probe_tool', {
        manifest_id: manifestId,
        url: decoyUrl,
        tool_name: 'search_docs',
        read_back_tool: 'list_spaces',
      }),
    );
    expect(result.observation?.observed.wrote).toBe(false);
    expect(result.findings).toEqual([]);
  });
});

describe('the manifest decides which server is called', () => {
  it('refuses a url that is not the one the manifest came from', async () => {
    // A benign manifest could otherwise authorise calling a same-named
    // destructive tool on a different server, with arguments built from the
    // wrong schema.
    const manifestId = await fetchDecoyManifest();
    const result = probeResultSchema.parse(
      await callVetit('probe_tool', {
        manifest_id: manifestId,
        url: 'http://127.0.0.1:9/mcp',
        tool_name: 'search_docs',
      }),
    );
    expect(result.probed).toBe(false);
    expect(result.refused).toContain('Refusing to call');
  });

  it('needs no url at all, because the manifest carries one', async () => {
    const manifestId = await fetchDecoyManifest();
    const result = probeResultSchema.parse(
      await callVetit('probe_tool', {
        manifest_id: manifestId,
        tool_name: 'search_docs',
      }),
    );
    expect(result.probed).toBe(true);
    expect(result.observation?.url).toBe(decoyUrl);
  });
});

describe('the rules a probe has to follow', () => {
  it('refuses a tool that admits it writes, unless told otherwise', async () => {
    const manifestId = await fetchDecoyManifest();
    const result = probeResultSchema.parse(
      await callVetit('probe_tool', {
        manifest_id: manifestId,
        url: decoyUrl,
        tool_name: 'create_page',
      }),
    );
    expect(result.probed).toBe(false);
    expect(result.refused).toContain('does not claim to be read-only');
  });

  it('probes a write when the risk is accepted explicitly', async () => {
    const manifestId = await fetchDecoyManifest();
    const result = probeResultSchema.parse(
      await callVetit('probe_tool', {
        manifest_id: manifestId,
        url: decoyUrl,
        tool_name: 'create_page',
        allow_non_read_only: true,
      }),
    );
    expect(result.probed).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('refuses a reader that is not read-only', async () => {
    const manifestId = await fetchDecoyManifest();
    const result = probeResultSchema.parse(
      await callVetit('probe_tool', {
        manifest_id: manifestId,
        url: decoyUrl,
        tool_name: 'search_docs',
        read_back_tool: 'create_page',
      }),
    );
    expect(result.probed).toBe(false);
    expect(result.refused).toContain('does not claim to be read-only');
  });

  it('refuses to call the same tool twice in one run', async () => {
    const manifestId = await fetchDecoyManifest();
    await callVetit('probe_tool', {
      manifest_id: manifestId,
      url: decoyUrl,
      tool_name: 'search_docs',
    });
    const second = probeResultSchema.parse(
      await callVetit('probe_tool', {
        manifest_id: manifestId,
        url: decoyUrl,
        tool_name: 'search_docs',
      }),
    );
    expect(second.probed).toBe(false);
    expect(second.refused).toContain('already been probed');
  });

  it('sends synthetic arguments, never anything real', async () => {
    const manifestId = await fetchDecoyManifest();
    const result = probeResultSchema.parse(
      await callVetit('probe_tool', {
        manifest_id: manifestId,
        url: decoyUrl,
        tool_name: 'add',
      }),
    );
    const sent = result.observation?.arguments_sent ?? {};
    expect(sent['a']).toBe(1);
    const sidenote = sent['sidenote'];
    expect(typeof sidenote === 'string' ? sidenote : '').toContain('canary');
  });

  it('refuses a tool that is not in the manifest, without calling anything', async () => {
    const manifestId = await fetchDecoyManifest();
    const result = probeResultSchema.parse(
      await callVetit('probe_tool', {
        manifest_id: manifestId,
        url: decoyUrl,
        tool_name: 'no_such_tool',
      }),
    );
    expect(result.probed).toBe(false);
    expect(result.refused).toContain('not in this manifest');
  });

  it('warns about the credential whenever one was supplied', async () => {
    const manifestId = await fetchDecoyManifest();
    const result = probeResultSchema.parse(
      await callVetit('probe_tool', {
        manifest_id: manifestId,
        url: decoyUrl,
        tool_name: 'list_spaces',
        credential_supplied: true,
      }),
    );
    const warning = result.findings?.find((finding) => finding.detector === 'P-04');
    expect(warning?.severity).toBe('high');
    expect(warning?.message).toContain('cannot see whether it is limited');
  });
});

describe('the tripwire', () => {
  it('plants the canary in the parameter most likely to be a way out', async () => {
    const manifestId = await fetchDecoyManifest();
    const result = probeResultSchema.parse(
      await callVetit('probe_tool', {
        manifest_id: manifestId,
        url: decoyUrl,
        tool_name: 'report_status',
      }),
    );
    const notes = result.observation?.arguments_sent['notes'];
    expect(typeof notes === 'string' ? notes : '').toContain('canary');
  });

  it('observes egress for a target on this machine', async () => {
    const manifestId = await fetchDecoyManifest();
    const result = probeResultSchema.parse(
      await callVetit('probe_tool', {
        manifest_id: manifestId,
        url: decoyUrl,
        tool_name: 'get_page',
      }),
    );
    expect(result.observation?.egress.status).toBe('observed');
  });
});
