import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerQuarantinedServer,
  writeAgentServerEntry,
  TrueforgeRequestError,
} from '../../../src/shared/trueforge-client/index.js';

/**
 * The admin client had no tests at all, which is how every request shape in it
 * was wrong against a real harness, and how both of the findings below got in.
 * The harness is a fake `fetch`: what matters here is which requests are made
 * and in what order, not what a server does with them.
 */

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

let recorded: Recorded[];
let handler: (request: Recorded) => { status: number; body: unknown };

beforeEach(() => {
  recorded = [];
  process.env['TRUEFORGE_BASE_URL'] = 'http://harness.test';
  vi.stubGlobal('fetch', (url: string, init: { method: string; body?: string }) => {
    const request: Recorded = {
      method: init.method,
      path: new URL(url).pathname,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    recorded.push(request);
    const { status, body } = handler(request);
    return Promise.resolve({
      ok: status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function connector(name: string, url: string): unknown {
  return { data: { name, manifest: { type: 'remote', name, url } } };
}

function agentRecord(servers: readonly unknown[]): Record<string, unknown> {
  return {
    id: 'agent-1',
    name: 'vetit',
    manifest: {
      model: { name: 'anthropic/claude-sonnet-5' },
      instructions: 'review servers',
      skills: [{ name: 'vetit-review' }],
      mcp_servers: servers,
    },
  };
}

function agent(servers: readonly unknown[]): unknown {
  return { data: agentRecord(servers) };
}

describe('a connector name already taken', () => {
  it('reuses it when the endpoint is the one being reviewed', async () => {
    handler = (request) => {
      if (request.method === 'POST') return { status: 409, body: { error: 'taken' } };
      return { status: 200, body: connector('decoy', 'http://127.0.0.1:8931/mcp') };
    };
    const result = await registerQuarantinedServer({
      name: 'decoy',
      url: 'http://127.0.0.1:8931/mcp',
    });
    expect(result.name).toBe('decoy');
    // Read, not written: a re-run of the same review changes nothing.
    expect(recorded.map((request) => request.method)).toEqual(['POST', 'GET']);
  });

  it('refuses when the existing connector points somewhere else', async () => {
    // A connector is global and its permissions are per-agent, so replacing it
    // would retarget every *other* agent already using the name — while this
    // review quarantines only its own. The hold would look applied and the
    // tools would keep being callable, against a new endpoint.
    handler = (request) => {
      if (request.method === 'POST') return { status: 409, body: { error: 'taken' } };
      return { status: 200, body: connector('shared', 'https://real-service.test/mcp') };
    };
    await expect(
      registerQuarantinedServer({ name: 'shared', url: 'http://127.0.0.1:8931/mcp' }),
    ).rejects.toBeInstanceOf(TrueforgeRequestError);
    expect(recorded.some((request) => request.method === 'PUT')).toBe(false);
  });

  it('says what to do instead of just failing', async () => {
    handler = (request) => {
      if (request.method === 'POST') return { status: 409, body: { error: 'taken' } };
      return { status: 200, body: connector('shared', 'https://real-service.test/mcp') };
    };
    await expect(
      registerQuarantinedServer({ name: 'shared', url: 'http://127.0.0.1:8931/mcp' }),
    ).rejects.toThrow(/different name/);
  });

  it('rotates a supplied credential on the same endpoint', async () => {
    handler = (request) => {
      if (request.method === 'POST') return { status: 409, body: { error: 'taken' } };
      if (request.method === 'GET') {
        return { status: 200, body: connector('decoy', 'http://127.0.0.1:8931/mcp') };
      }
      return { status: 200, body: connector('decoy', 'http://127.0.0.1:8931/mcp') };
    };
    await registerQuarantinedServer({
      name: 'decoy',
      url: 'http://127.0.0.1:8931/mcp',
      auth: { type: 'header', headers: { Authorization: 'Bearer x' } },
    });
    expect(recorded.map((request) => request.method)).toEqual(['POST', 'GET', 'PUT']);
  });
});

describe('writing a grant onto an agent', () => {
  it('carries the rest of the manifest through untouched', async () => {
    handler = (request) => {
      if (request.method === 'GET') {
        return { status: 200, body: { data: [agentRecord([])] } };
      }
      return { status: 200, body: agent([]) };
    };
    await writeAgentServerEntry({
      agentName: 'vetit',
      entry: { name: 'decoy', disable_tools: ['@all'] },
    });
    const put = recorded.find((request) => request.method === 'PUT');
    const manifest = (put?.body as { manifest: Record<string, unknown> }).manifest;
    expect(manifest['model']).toEqual({ name: 'anthropic/claude-sonnet-5' });
    expect(manifest['skills']).toEqual([{ name: 'vetit-review' }]);
    expect(manifest['instructions']).toBe('review servers');
  });

  it('serialises concurrent writes rather than losing one', async () => {
    // Both grants must survive. Read-modify-PUT on an unversioned manifest
    // means the second writer reading before the first has written would drop
    // the first's entry entirely.
    let servers: unknown[] = [];
    handler = (request) => {
      if (request.method === 'GET') {
        return { status: 200, body: { data: [agentRecord(servers)] } };
      }
      const sent = (request.body as { manifest: { mcp_servers: unknown[] } }).manifest;
      servers = sent.mcp_servers;
      return { status: 200, body: agent(servers) };
    };

    await Promise.all([
      writeAgentServerEntry({
        agentName: 'vetit',
        entry: { name: 'alpha', disable_tools: ['@all'] },
      }),
      writeAgentServerEntry({
        agentName: 'vetit',
        entry: { name: 'beta', disable_tools: ['@all'] },
      }),
    ]);

    const names = servers.map((entry) => (entry as { name: string }).name).sort();
    expect(names).toEqual(['alpha', 'beta']);
  });

  it('refuses rather than overwriting state that keeps moving', async () => {
    let counter = 0;
    handler = (request) => {
      if (request.method === 'GET') {
        counter += 1;
        return {
          status: 200,
          body: { data: [agentRecord([{ name: `moving-${String(counter)}` }])] },
        };
      }
      return { status: 200, body: agent([]) };
    };
    await expect(
      writeAgentServerEntry({
        agentName: 'vetit',
        entry: { name: 'decoy', disable_tools: ['@all'] },
      }),
    ).rejects.toThrow(/moved under this update/);
    expect(recorded.some((request) => request.method === 'PUT')).toBe(false);
  });
});
