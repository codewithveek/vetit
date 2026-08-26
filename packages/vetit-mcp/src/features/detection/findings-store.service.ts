import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ensureWorkdirSubdirectory } from '../../shared/workdir/index.js';
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

async function resolveFindingsPath(manifestId: string): Promise<string> {
  const directory = await ensureWorkdirSubdirectory('reports');
  return join(directory, `${manifestId}.findings.json`);
}

export async function readStoredFindings(
  manifestId: string,
): Promise<readonly Finding[]> {
  try {
    const raw = await readFile(await resolveFindingsPath(manifestId), 'utf8');
    const parsed = findingsFileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.findings : [];
  } catch {
    return [];
  }
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
 * Adds this run's findings to whatever was already recorded for the manifest,
 * then renumbers the whole set so the F-numbers stay contiguous.
 */
export async function mergeStoredFindings(
  options: MergeFindingsOptions,
): Promise<readonly Finding[]> {
  const existing = await readStoredFindings(options.manifestId);
  const byIdentity = new Map(existing.map((finding) => [identify(finding), finding]));
  for (const finding of options.findings) {
    byIdentity.set(identify(finding), finding);
  }
  const merged = renumber([...byIdentity.values()]);
  await writeFile(
    await resolveFindingsPath(options.manifestId),
    JSON.stringify({ manifestId: options.manifestId, findings: merged }, undefined, 2),
    'utf8',
  );
  return merged;
}
