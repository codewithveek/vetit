import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureWorkdirSubdirectory } from '../../shared/workdir/index.js';
import { storedManifestSchema } from './manifest.schema.js';
import type { StoredManifest } from './manifest.types.js';

/**
 * Manifests go to disk, not into the context.
 *
 * The raw text a target sent is the attack. Keeping it in a file means the
 * agent can point a detector at it, a human can open it, and no untrusted
 * sentence is ever read by the model as though it were an instruction.
 */


export async function resolveManifestPath(manifestId: string): Promise<string> {
  const directory = await ensureWorkdirSubdirectory('manifests');
  return join(directory, `${manifestId}.json`);
}

export async function writeStoredManifest(
  manifest: StoredManifest,
): Promise<string> {
  const path = await resolveManifestPath(manifest.manifestId);
  await writeFile(path, JSON.stringify(manifest, undefined, 2), 'utf8');
  return path;
}

export class ManifestNotFoundError extends Error {
  constructor(manifestId: string) {
    super(`No stored manifest with id ${manifestId}.`);
    this.name = 'ManifestNotFoundError';
  }
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
