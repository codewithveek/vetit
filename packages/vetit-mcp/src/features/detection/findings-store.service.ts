import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { ensureWorkdirSubdirectory } from '../../shared/workdir/index.js';
import { assertManifestId, InvalidManifestIdError } from '../manifest/index.js';
import type { Finding } from './finding.types.js';

/**
 * Findings live on disk between tool calls.
 *
 * `compute_risk` takes a manifest id, not a list of findings, because the spec
 * says it "adds up the *stored* findings". That matters for two reasons: the
 * agent never has to carry a findings array through its context, and the score
 * is computed from the same record a human can open and read.
 *
 * Each scan merges into the file rather than replacing it, keyed on the
 * finding's identity, so running `scan_descriptions` and then `analyze_schemas`
 * leaves one complete record instead of the last one to run.
 */

const severitySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);

const findingSchema = z.object({
  id: z.string(),
  detector: z.string(),
  severity: severitySchema,
  tool: z.string(),
  message: z.string(),
  evidence: z.object({
    path: z.string(),
    jsonPointer: z.string(),
    snippet: z.string(),
  }),
  fix: z.string(),
});

const findingsFileSchema = z.object({
  manifestId: z.string(),
  findings: z.array(findingSchema),
});

/**
 * The same guard the manifest store uses, for the same reason.
 *
 * Findings are keyed by manifest id, and this path was built by interpolating
 * that id straight into a filename — so a traversing id could read or
 * overwrite a `.findings.json` file anywhere the process could reach. The
 * check is imported rather than copied so the two stores cannot drift into
 * disagreeing about what an id is.
 */
async function resolveFindingsPath(manifestId: string): Promise<string> {
  assertManifestId(manifestId);
  const directory = await ensureWorkdirSubdirectory('reports');
  const path = resolve(join(directory, `${manifestId}.findings.json`));
  if (dirname(path) !== resolve(directory)) {
    throw new InvalidManifestIdError(manifestId);
  }
  return path;
}

/**
 * Something went wrong with the stored record itself.
 *
 * Kept distinct from "there is nothing recorded yet" because the two used to
 * be indistinguishable, and one of them is a security finding.
 */
export class FindingsStorageError extends Error {
  constructor(manifestId: string, reason: string) {
    super(
      `The findings recorded for ${manifestId} could not be read: ${reason}. ` +
        'Refusing to treat a damaged record as an empty one — rerun the scans ' +
        'or delete the file deliberately.',
    );
    this.name = 'FindingsStorageError';
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
 * No findings recorded yet is a normal state — a manifest that has been
 * fetched but not scanned has none — so a *missing file* reads as an empty
 * list. Nothing else does.
 *
 * Everything else used to read as an empty list too: malformed JSON, a schema
 * mismatch, a permissions error, a half-written file. compute_risk would then
 * report zero and say "nothing was checked", and the next scan would overwrite
 * the damaged record as though it had never held anything. A security tool
 * that turns corruption into a clean score is worse than one that crashes.
 */
export async function readStoredFindings(
  manifestId: string,
): Promise<readonly Finding[]> {
  const path = await resolveFindingsPath(manifestId);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw new FindingsStorageError(manifestId, String(error));
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new FindingsStorageError(manifestId, 'the file is not valid JSON');
  }

  const parsed = findingsFileSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new FindingsStorageError(manifestId, 'the file is not a findings record');
  }
  if (parsed.data.manifestId !== manifestId) {
    throw new FindingsStorageError(
      manifestId,
      `it records findings for ${parsed.data.manifestId} instead`,
    );
  }
  return parsed.data.findings;
}

/** What makes two findings the same finding. Deliberately not the F-number. */
function identify(finding: Finding): string {
  return `${finding.detector}|${finding.tool}|${finding.evidence.jsonPointer}|${finding.message}`;
}

function renumber(findings: readonly Finding[]): Finding[] {
  return findings.map((finding, index) => ({
    ...finding,
    id: `F-${String(index + 1).padStart(3, '0')}`,
  }));
}

export interface MergeFindingsOptions {
  readonly manifestId: string;
  readonly findings: readonly Finding[];
}

/**
 * One in-flight merge per manifest.
 *
 * The merge is a read, a change and a write, and nothing held the three
 * together. Two scans running at once both read the same baseline and the
 * second write discarded the first scan's findings — so a review that ran
 * every detector could persist the results of only some of them, and the risk
 * score would undercount without anything looking wrong.
 *
 * A promise chain per manifest id is enough here because the workdir belongs
 * to one Vetit process. It is not a cross-process lock, and it does not claim
 * to be: two servers sharing a workdir would still race, which is a thing not
 * to do rather than a thing this file can fix.
 */
const mergesInFlight = new Map<string, Promise<readonly Finding[]>>();

function mergeFindings(
  existing: readonly Finding[],
  incoming: readonly Finding[],
): Finding[] {
  const byIdentity = new Map(existing.map((finding) => [identify(finding), finding]));
  for (const finding of incoming) byIdentity.set(identify(finding), finding);
  return renumber([...byIdentity.values()]);
}

/**
 * Write beside the target, then rename over it.
 *
 * `rename` is atomic within a directory, so a reader either sees the whole
 * previous record or the whole new one. Writing in place left a window where
 * the file was half a JSON document — and the reader now refuses to parse
 * that rather than calling it zero findings, which would turn a torn write
 * into a clean score.
 */
async function writeFindingsAtomically(
  path: string,
  contents: string,
): Promise<void> {
  const temporaryPath = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporaryPath, contents, 'utf8');
  await rename(temporaryPath, path);
}

async function performMerge(
  options: MergeFindingsOptions,
): Promise<readonly Finding[]> {
  const path = await resolveFindingsPath(options.manifestId);
  const merged = mergeFindings(
    await readStoredFindings(options.manifestId),
    options.findings,
  );
  await writeFindingsAtomically(
    path,
    JSON.stringify({ manifestId: options.manifestId, findings: merged }, undefined, 2),
  );
  return merged;
}

/**
 * Adds this run's findings to whatever was already recorded for the manifest,
 * then renumbers the whole set so the F-numbers stay contiguous.
 *
 * Serialised per manifest: a merge that arrives while another is running waits
 * for it, so it reads a baseline that already includes the other's work.
 */
export async function mergeStoredFindings(
  options: MergeFindingsOptions,
): Promise<readonly Finding[]> {
  const previous = mergesInFlight.get(options.manifestId);
  const next = (previous ?? Promise.resolve([]))
    .catch(() => [])
    .then(async () => await performMerge(options));
  mergesInFlight.set(options.manifestId, next);
  try {
    return await next;
  } finally {
    if (mergesInFlight.get(options.manifestId) === next) {
      mergesInFlight.delete(options.manifestId);
    }
  }
}
