import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import {
  mergeStoredFindings,
  readStoredFindings,
} from '../../../src/features/detection/index.js';
import { InvalidManifestIdError } from '../../../src/features/manifest/index.js';
import type { Finding } from '../../../src/features/detection/index.js';

/**
 * The findings store is keyed by manifest id and used to interpolate it
 * straight into a filename, exactly as the manifest store did. Same bug, same
 * guard — imported rather than copied, so the two cannot drift into
 * disagreeing about what an id is.
 */

let workdir: string;
let previousWorkdir: string | undefined;

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'vetit-findings-'));
  previousWorkdir = process.env['VETIT_WORKDIR'];
  process.env['VETIT_WORKDIR'] = workdir;
});

afterAll(async () => {
  process.env['VETIT_WORKDIR'] = previousWorkdir ?? '';
  await rm(workdir, { recursive: true, force: true });
});

function finding(tool: string): Finding {
  return {
    id: 'F-001',
    detector: 'D-01',
    severity: 'critical',
    tool,
    message: 'test finding',
    evidence: { path: '/tmp/m.json', jsonPointer: '/tools/0', snippet: 'x' },
    fix: 'test fix',
  };
}

describe('path handling', () => {
  it('refuses a traversing id on read', async () => {
    await expect(readStoredFindings('../escape')).rejects.toBeInstanceOf(
      InvalidManifestIdError,
    );
  });

  it('refuses a traversing id on write', async () => {
    await expect(
      mergeStoredFindings({ manifestId: '../escape', findings: [finding('a')] }),
    ).rejects.toBeInstanceOf(InvalidManifestIdError);
  });

  it('does not read a file it was pointed at from outside', async () => {
    const outside = join(workdir, 'reports', 'planted.findings.json');
    await mergeStoredFindings({ manifestId: ulid(), findings: [] });
    await writeFile(outside, JSON.stringify({ manifestId: 'x', findings: [] }), 'utf8');
    await expect(readStoredFindings('planted')).rejects.toBeInstanceOf(
      InvalidManifestIdError,
    );
  });
});

describe('what an empty result means', () => {
  it('reads as empty when a valid manifest simply has no findings yet', async () => {
    expect(await readStoredFindings(ulid())).toEqual([]);
  });

  it('does not turn a refused identifier into an empty list', async () => {
    // Swallowing that would make "this id is not an id" indistinguishable
    // from "this manifest is clean".
    await expect(readStoredFindings('not-an-id')).rejects.toBeInstanceOf(
      InvalidManifestIdError,
    );
  });
});

describe('merging', () => {
  it('accumulates across calls rather than replacing', async () => {
    const manifestId = ulid();
    await mergeStoredFindings({ manifestId, findings: [finding('one')] });
    const merged = await mergeStoredFindings({
      manifestId,
      findings: [finding('two')],
    });
    expect(merged.map((entry) => entry.tool).sort()).toEqual(['one', 'two']);
  });

  it('renumbers so the F-numbers stay contiguous', async () => {
    const manifestId = ulid();
    await mergeStoredFindings({ manifestId, findings: [finding('a'), finding('b')] });
    const merged = await mergeStoredFindings({ manifestId, findings: [finding('c')] });
    expect(merged.map((entry) => entry.id)).toEqual(['F-001', 'F-002', 'F-003']);
  });
});
