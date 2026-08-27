import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import {
  InvalidManifestIdError,
  ManifestNotFoundError,
  readStoredManifest,
  resolveManifestPath,
} from '../../../src/features/manifest/index.js';

/**
 * Manifest ids used to be interpolated straight into a path, so a caller
 * passing `../../../etc/something` could read or overwrite any `.json` file
 * the process could reach. Ids are minted by Vetit and never typed by a
 * reviewer, so anything that is not a ULID is either a bug or an attempt.
 */

let workdir: string;
let previousWorkdir: string | undefined;

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'vetit-store-'));
  previousWorkdir = process.env['VETIT_WORKDIR'];
  process.env['VETIT_WORKDIR'] = workdir;
});

afterAll(async () => {
  process.env['VETIT_WORKDIR'] = previousWorkdir ?? '';
  await rm(workdir, { recursive: true, force: true });
});

const TRAVERSALS = [
  '../escape',
  '../../escape',
  '..\\escape',
  'nested/escape',
  'nested\\escape',
  '/etc/passwd',
  'C:\\Windows\\win',
  '.',
  '..',
  '',
];

/** The smallest thing the stored-manifest schema will accept. */
function manifestShapedRecord(manifestId: string): Record<string, unknown> {
  return {
    manifestId,
    fetchedAt: '2026-08-27T00:00:00.000Z',
    source: { kind: 'direct', url: 'http://127.0.0.1:1/mcp' },
    tools: [],
    unparseableToolCount: 0,
    resourceNames: [],
    promptNames: [],
    resourcesStatus: 'unsupported',
    promptsStatus: 'unsupported',
    manifestHash: 'hash',
    perToolHashes: {},
    duplicateToolNames: [],
    raw: { tools: [], pageCounts: { tools: 1, resources: 0, prompts: 0 } },
  };
}

describe('resolveManifestPath', () => {
  it('accepts an id it minted itself', async () => {
    const id = ulid();
    const path = await resolveManifestPath(id);
    expect(path.endsWith(`${id}.json`)).toBe(true);
  });

  it('keeps the file a direct child of the manifests directory', async () => {
    const id = ulid();
    const path = await resolveManifestPath(id);
    expect(dirname(path).endsWith('manifests')).toBe(true);
  });

  it('refuses every shape of traversal', async () => {
    for (const manifestId of TRAVERSALS) {
      await expect(resolveManifestPath(manifestId)).rejects.toBeInstanceOf(
        InvalidManifestIdError,
      );
    }
  });

  it('refuses an id of the right length that is not a ULID', async () => {
    // Crockford base32 excludes I, L, O and U.
    await expect(resolveManifestPath('I'.repeat(26))).rejects.toBeInstanceOf(
      InvalidManifestIdError,
    );
    await expect(resolveManifestPath('a'.repeat(26))).rejects.toBeInstanceOf(
      InvalidManifestIdError,
    );
  });

  it('refuses an id of the wrong length', async () => {
    await expect(resolveManifestPath('0'.repeat(25))).rejects.toBeInstanceOf(
      InvalidManifestIdError,
    );
    await expect(resolveManifestPath('0'.repeat(27))).rejects.toBeInstanceOf(
      InvalidManifestIdError,
    );
  });
});

describe('readStoredManifest', () => {
  it('refuses a traversing id before it touches the disk', async () => {
    const outside = join(workdir, 'secret.json');
    await writeFile(outside, JSON.stringify({ secret: true }), 'utf8');
    await expect(
      readStoredManifest('../secret'),
    ).rejects.toBeInstanceOf(InvalidManifestIdError);
  });

  it('reports a well-formed id that is simply not there', async () => {
    await expect(readStoredManifest(ulid())).rejects.toBeInstanceOf(
      ManifestNotFoundError,
    );
  });

  it('writes nothing outside the manifests directory', async () => {
    const manifests = join(workdir, 'manifests');
    await resolveManifestPath(ulid());
    const entries = await readdir(manifests);
    expect(entries.every((entry) => entry.endsWith('.json') || entries.length === 0)).toBe(
      true,
    );
  });
});

describe('a manifest that is not the manifest it should be', () => {
  async function writeRaw(manifestId: string, contents: string): Promise<void> {
    await writeFile(await resolveManifestPath(manifestId), contents, 'utf8');
  }

  it('refuses a record belonging to a different manifest', async () => {
    // Admission pairs this record with a findings record keyed separately, so
    // a copied file could apply permissions derived from one tool surface and
    // another review's findings.
    const manifestId = ulid();
    await writeRaw(manifestId, JSON.stringify({ ...manifestShapedRecord(ulid()) }));
    await expect(readStoredManifest(manifestId)).rejects.toThrow(/instead/);
  });

  it('refuses a file that is not valid JSON, and names the manifest', async () => {
    const manifestId = ulid();
    await writeRaw(manifestId, '{ "tools": [ truncated');
    await expect(readStoredManifest(manifestId)).rejects.toThrow(/not valid JSON/);
    await expect(readStoredManifest(manifestId)).rejects.toThrow(manifestId);
  });

  it('refuses a file that is valid JSON but not a manifest', async () => {
    const manifestId = ulid();
    await writeRaw(manifestId, JSON.stringify({ something: 'else' }));
    await expect(readStoredManifest(manifestId)).rejects.toThrow(/not a manifest record/);
  });

  it('still reports a genuinely absent manifest as not found', async () => {
    await expect(readStoredManifest(ulid())).rejects.toBeInstanceOf(
      ManifestNotFoundError,
    );
  });

  it('accepts a record whose id matches', async () => {
    const manifestId = ulid();
    await writeRaw(manifestId, JSON.stringify(manifestShapedRecord(manifestId)));
    const stored = await readStoredManifest(manifestId);
    expect(stored.manifestId).toBe(manifestId);
  });
});
