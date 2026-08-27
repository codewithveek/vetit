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
