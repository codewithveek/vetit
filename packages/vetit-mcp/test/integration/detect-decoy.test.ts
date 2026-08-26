import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDecoyApp } from '../../../vetit-decoy-mcp/src/decoy-server.js';
import {
  computeRisk,
  runDetectorsWithInstalled,
  type DetectionRun,
} from '../../src/features/detection/index.js';
import {
  fetchManifest,
  readStoredManifest,
  resolveManifestPath,
} from '../../src/features/manifest/index.js';

/**
 * The test that says whether any of this works.
 *
 * It stands the decoy up, fetches its real manifest over MCP, runs every
 * detector, and checks that each planted flaw is found by the detector that is
 * supposed to find it — and, just as importantly, that the honest tools come
 * back clean.
 */

let server: Server;
let detection: DetectionRun;
let workdir: string;
let previousWorkdir: string | undefined;

function findingsFor(tool: string, detector: string): number {
  return detection.findings.filter(
    (finding) => finding.tool === tool && finding.detector === detector,
  ).length;
}

function detectorsFor(tool: string): readonly string[] {
  return [
    ...new Set(
      detection.findings
        .filter((finding) => finding.tool === tool)
        .map((finding) => finding.detector),
    ),
  ].sort();
}

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'vetit-detect-'));
  previousWorkdir = process.env['VETIT_WORKDIR'];
  process.env['VETIT_WORKDIR'] = workdir;

  server = createServer(createDecoyApp({ isPoisoned: false }));
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');

  const summary = await fetchManifest({
    url: `http://127.0.0.1:${String(address.port)}/mcp`,
    connectorName: undefined,
  });
  const manifest = await readStoredManifest(summary.manifest_id);
  detection = runDetectorsWithInstalled({
    manifest,
    manifestPath: await resolveManifestPath(summary.manifest_id),
    installedToolNames: ['post_message', 'create_issue', 'read_file'],
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  if (previousWorkdir === undefined) delete process.env['VETIT_WORKDIR'];
  else process.env['VETIT_WORKDIR'] = previousWorkdir;
  await rm(workdir, { recursive: true, force: true });
});

describe('every planted flaw is caught by the detector meant to catch it', () => {
  it('D-01 and D-05 find the hidden block in `add`', () => {
    expect(findingsFor('add', 'D-01')).toBeGreaterThanOrEqual(1);
    expect(findingsFor('add', 'D-05')).toBeGreaterThanOrEqual(1);
  });

  it('D-07 finds the undocumented sidenote parameter', () => {
    expect(findingsFor('add', 'D-07')).toBe(1);
  });

  it('D-02 finds the invisible characters in `summarise_page`', () => {
    expect(findingsFor('summarise_page', 'D-02')).toBe(1);
  });

  it('D-03 finds the homoglyph tool name', () => {
    expect(findingsFor('sendm\u0435ssage', 'D-03')).toBe(1);
  });

  it('D-09 finds the cross-server references', () => {
    expect(findingsFor('list_workspace_files', 'D-09')).toBeGreaterThanOrEqual(1);
  });

  it('D-06 and D-10 find the buried collector URLs', () => {
    expect(findingsFor('report_status', 'D-06')).toBe(1);
    expect(findingsFor('report_status', 'D-10')).toBe(1);
  });

  it('D-08 finds both unannotated tools', () => {
    expect(findingsFor('check_environment', 'D-08')).toBe(1);
    expect(findingsFor('sendm\u0435ssage', 'D-08')).toBe(1);
  });
});

describe('the honest tools come back clean', () => {
  it('finds nothing wrong with search_docs, get_page or list_spaces', () => {
    expect(detectorsFor('search_docs')).toEqual([]);
    expect(detectorsFor('get_page')).toEqual([]);
    expect(detectorsFor('list_spaces')).toEqual([]);
  });

  it('finds nothing wrong with create_page, which is an honest write', () => {
    expect(detectorsFor('create_page')).toEqual([]);
  });
});

describe('what static review cannot reach', () => {
  it('says nothing at all about export_all', () => {
    // export_all is annotated readOnlyHint: true and writes. Its description
    // is clean, its schema is clean, its annotations are complete. This is the
    // gap probe_tool exists to close, and the test asserts the gap is real.
    expect(detectorsFor('export_all')).toEqual([]);
  });
});

describe('the report as a whole', () => {
  it('numbers findings in a stable order', () => {
    const ids = detection.findings.map((finding) => finding.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids[0]).toBe('F-001');
  });

  it('gives every finding a path and a pointer into the manifest file', () => {
    for (const finding of detection.findings) {
      expect(finding.evidence.path.endsWith('.json')).toBe(true);
      expect(finding.evidence.jsonPointer).toMatch(/^\/tools\/\d+/);
    }
  });

  it('cleans every snippet it reports', () => {
    for (const finding of detection.findings) {
      expect(finding.evidence.snippet.startsWith('\u27E6UNTRUSTED_TEXT: ')).toBe(true);
      expect(finding.evidence.snippet).not.toMatch(/[<>]/);
    }
  });

  it('scores the decoy as a rejection', () => {
    const assessment = computeRisk(detection.findings);
    expect(assessment.band).toBe('reject_recommended');
    expect(assessment.counts.critical).toBeGreaterThanOrEqual(3);
  });
});
