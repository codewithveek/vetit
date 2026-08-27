import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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

describe('corruption is not an empty record', () => {
  // Every read failure used to become an empty list, so compute_risk would
  // report zero and say "nothing was checked", and the next scan would
  // overwrite the damaged file as though it had never held anything.
  async function writeRaw(manifestId: string, contents: string): Promise<void> {
    await mergeStoredFindings({ manifestId, findings: [] });
    const reports = join(workdir, 'reports');
    await writeFile(join(reports, `${manifestId}.findings.json`), contents, 'utf8');
  }

  it('refuses a file that is not valid JSON', async () => {
    const manifestId = ulid();
    await writeRaw(manifestId, '{ "findings": [ truncated');
    await expect(readStoredFindings(manifestId)).rejects.toThrow(/not valid JSON/);
  });

  it('refuses a file that is valid JSON but not a findings record', async () => {
    const manifestId = ulid();
    await writeRaw(manifestId, JSON.stringify({ something: 'else' }));
    await expect(readStoredFindings(manifestId)).rejects.toThrow(
      /not a findings record/,
    );
  });

  it('refuses a record belonging to a different manifest', async () => {
    const manifestId = ulid();
    await writeRaw(
      manifestId,
      JSON.stringify({ manifestId: ulid(), findings: [] }),
    );
    await expect(readStoredFindings(manifestId)).rejects.toThrow(/instead/);
  });

  it('refuses a findings entry with the wrong shape', async () => {
    const manifestId = ulid();
    await writeRaw(
      manifestId,
      JSON.stringify({ manifestId, findings: [{ id: 'F-001' }] }),
    );
    await expect(readStoredFindings(manifestId)).rejects.toThrow(
      /not a findings record/,
    );
  });

  it('says what to do about it rather than only that it failed', async () => {
    const manifestId = ulid();
    await writeRaw(manifestId, 'not json at all');
    await expect(readStoredFindings(manifestId)).rejects.toThrow(/rerun the scans/);
  });
});

describe('concurrent merges', () => {
  it('keeps the union when two scans run at once', async () => {
    // Read, change, write — with nothing holding the three together, two
    // parallel scans both read the same baseline and the second write
    // discarded the first scan's findings.
    const manifestId = ulid();
    const [first, second] = await Promise.all([
      mergeStoredFindings({ manifestId, findings: [finding('alpha')] }),
      mergeStoredFindings({ manifestId, findings: [finding('beta')] }),
    ]);
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    const stored = await readStoredFindings(manifestId);
    expect(stored.map((entry) => entry.tool).sort()).toEqual(['alpha', 'beta']);
  });

  it('keeps every finding when many scans run at once', async () => {
    const manifestId = ulid();
    const tools = Array.from({ length: 12 }, (_, index) => `tool_${String(index)}`);
    await Promise.all(
      tools.map(async (tool) =>
        mergeStoredFindings({ manifestId, findings: [finding(tool)] }),
      ),
    );
    const stored = await readStoredFindings(manifestId);
    expect(stored.map((entry) => entry.tool).sort()).toEqual([...tools].sort());
  });

  it('leaves the numbering contiguous after a concurrent burst', async () => {
    const manifestId = ulid();
    await Promise.all(
      ['a', 'b', 'c'].map(async (tool) =>
        mergeStoredFindings({ manifestId, findings: [finding(tool)] }),
      ),
    );
    const stored = await readStoredFindings(manifestId);
    expect(stored.map((entry) => entry.id)).toEqual(['F-001', 'F-002', 'F-003']);
  });

  it('leaves no temporary files behind', async () => {
    const manifestId = ulid();
    await Promise.all(
      ['a', 'b'].map(async (tool) =>
        mergeStoredFindings({ manifestId, findings: [finding(tool)] }),
      ),
    );
    const entries = await readdir(join(workdir, 'reports'));
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
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
