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

/**
 * The record exists but is not the record it should be.
 *
 * Kept apart from "no such manifest" because the two mean opposite things: one
 * says fetch it, the other says something is wrong with what is on disk and
 * nothing downstream should treat it as a review.
 */
export class ManifestStorageError extends Error {
  constructor(manifestId: string, reason: string) {
    super(
      `The manifest stored for ${manifestId} could not be trusted: ${reason}. ` +
        'Fetch the target again rather than reviewing this file.',
    );
    this.name = 'ManifestStorageError';
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

/**
 * Reads a manifest back off disk, checked rather than trusted.
 *
 * Only a missing file means "not found". Everything else — unreadable, not
 * JSON, not a manifest, or a manifest belonging to a *different* id — is a
 * storage problem and says so. The id check is the one review asked for and it
 * matters more than it looks: admission pairs this record with a findings
 * record keyed separately, so a copied or edited file could apply permissions
 * derived from one tool surface and another review's findings.
 */
export async function readStoredManifest(
  manifestId: string,
): Promise<StoredManifest> {
  const path = await resolveManifestPath(manifestId);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) throw new ManifestNotFoundError(manifestId);
    throw new ManifestStorageError(manifestId, String(error));
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    // JSON.parse used to sit outside the try, so a truncated file threw a bare
    // SyntaxError with no manifest id in it.
    throw new ManifestStorageError(manifestId, 'the file is not valid JSON');
  }

  const parsed = storedManifestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new ManifestStorageError(manifestId, 'the file is not a manifest record');
  }
  if (parsed.data.manifestId !== manifestId) {
    throw new ManifestStorageError(
      manifestId,
      `it records the manifest for ${parsed.data.manifestId} instead`,
    );
  }
  return parsed.data;
}
