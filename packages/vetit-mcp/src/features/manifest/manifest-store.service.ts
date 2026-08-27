import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ensureWorkdirSubdirectory } from '../../shared/workdir/index.js';
import { storedManifestSchema } from './manifest.schema.js';
import type { StoredManifest } from './manifest.schema.js';

/**
 * Manifests go to disk, not into the context.
 *
 * The raw text a target sent is the attack. Keeping it in a file means the
 * agent can point a detector at it, a human can open it, and no untrusted
 * sentence is ever read by the model as though it were an instruction.
 */

/**
 * Crockford base32, 26 characters — the alphabet ULID uses, which excludes
 * I, L, O and U.
 *
 * The identifier used to be interpolated straight into a path, so a caller
 * passing `../../../etc/whatever` could read or overwrite any `.json` file the
 * process could reach. Manifest ids are minted by Vetit and never by a
 * reviewer, so anything that is not a ULID is either a bug or an attempt.
 */
const MANIFEST_ID_PATTERN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

export class InvalidManifestIdError extends Error {
  constructor(manifestId: string) {
    super(`Not a manifest id: ${JSON.stringify(manifestId)}`);
    this.name = 'InvalidManifestIdError';
  }
}

export class ManifestNotFoundError extends Error {
  constructor(manifestId: string) {
    super(`No stored manifest with id ${manifestId}.`);
    this.name = 'ManifestNotFoundError';
  }
}

/**
 * Two checks, not one.
 *
 * The pattern alone makes traversal impossible, and the containment check
 * alone would too. Both are here because they fail differently: the pattern
 * says what an id is, and the containment check says what the result must be
 * regardless of how the path was built. A future change to the filename
 * scheme cannot quietly reopen this.
 */
export function assertManifestId(manifestId: string): void {
  if (!MANIFEST_ID_PATTERN.test(manifestId)) {
    throw new InvalidManifestIdError(manifestId);
  }
}

export async function resolveManifestPath(manifestId: string): Promise<string> {
  assertManifestId(manifestId);
  const directory = await ensureWorkdirSubdirectory('manifests');
  const path = resolve(join(directory, `${manifestId}.json`));
  if (dirname(path) !== resolve(directory)) {
    throw new InvalidManifestIdError(manifestId);
  }
  return path;
}

export async function writeStoredManifest(
  manifest: StoredManifest,
): Promise<string> {
  const path = await resolveManifestPath(manifest.manifestId);
  await writeFile(path, JSON.stringify(manifest, undefined, 2), 'utf8');
  return path;
}

/** Reads a manifest back off disk, checked rather than trusted. */
export async function readStoredManifest(
  manifestId: string,
): Promise<StoredManifest> {
  const path = await resolveManifestPath(manifestId);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new ManifestNotFoundError(manifestId);
  }
  const parsed = storedManifestSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new ManifestNotFoundError(manifestId);
  return parsed.data;
}
