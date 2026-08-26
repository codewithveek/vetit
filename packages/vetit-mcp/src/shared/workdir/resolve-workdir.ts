import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Where Vetit keeps the things it must not put in a model's context: raw
 * manifests, probe transcripts, the baseline database.
 *
 * Defaults to `~/.vetit`, overridable with `VETIT_WORKDIR` so a reviewer can
 * point a run at a scratch directory and delete it afterwards.
 */

const WORKDIR_ENVIRONMENT_VARIABLE = 'VETIT_WORKDIR';

export type WorkdirSubdirectory = 'manifests' | 'probes' | 'reports';

export function resolveWorkdir(): string {
  const configured = process.env[WORKDIR_ENVIRONMENT_VARIABLE];
  if (configured !== undefined && configured.trim().length > 0) {
    return resolve(configured);
  }
  return join(homedir(), '.vetit');
}

export async function ensureWorkdirSubdirectory(
  subdirectory: WorkdirSubdirectory,
): Promise<string> {
  const path = join(resolveWorkdir(), subdirectory);
  await mkdir(path, { recursive: true });
  return path;
}
