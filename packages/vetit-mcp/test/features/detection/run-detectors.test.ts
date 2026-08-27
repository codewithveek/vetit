import { describe, expect, it } from 'vitest';
import { runDetectors } from '../../../src/features/detection/index.js';
import type { ManifestTool, StoredManifest } from '../../../src/features/manifest/index.js';

/**
 * What the default runner does about shadowing, and why.
 *
 * The doc comment used to claim `installedToolNames` defaulted to the
 * manifest's own tools while the code passed an empty list. The comment was
 * wrong, and these tests pin the behaviour so nobody "fixes" it in the other
 * direction by mistake.
 */

const siblingReference: ManifestTool = {
  name: 'get_page',
  description: 'Returns a page. Call list_spaces first to find the space id.',
  annotations: { readOnlyHint: true, destructiveHint: false },
};

const listSpaces: ManifestTool = {
  name: 'list_spaces',
  description: 'Lists the spaces.',
  annotations: { readOnlyHint: true, destructiveHint: false },
};

function manifestOf(tools: readonly ManifestTool[]): StoredManifest {
  return {
    manifestId: '01J0000000000000000000000M',
    fetchedAt: '2026-08-27T00:00:00.000Z',
    source: { kind: 'direct', url: 'http://127.0.0.1:1/mcp' },
    tools: [...tools],
    unparseableToolCount: 0,
    resourceNames: [],
    promptNames: [],
    resourcesStatus: 'unsupported',
    promptsStatus: 'unsupported',
    manifestHash: 'hash',
    perToolHashes: {},
    duplicateToolNames: [],
    raw: {
      tools: [...tools],
      pageCounts: { tools: 1, resources: 0, prompts: 0 },
    },
  };
}

function detectorsFired(
  findings: readonly { detector: string; tool: string }[],
  tool: string,
): readonly string[] {
  return [
    ...new Set(
      findings.filter((finding) => finding.tool === tool).map((f) => f.detector),
    ),
  ];
}

describe('the shadowing context is always stated', () => {
  it('runs the installed-name signal when a workspace list is supplied', () => {
    const run = runDetectors({
      manifest: manifestOf([siblingReference]),
      manifestPath: '/tmp/m.json',
      installedToolNames: ['list_spaces'],
    });
    expect(detectorsFired(run.findings, 'get_page')).toContain('D-09');
  });

  it('switches the signal off when the caller says there is no list', () => {
    const run = runDetectors({
      manifest: manifestOf([siblingReference, listSpaces]),
      manifestPath: '/tmp/m.json',
      installedToolNames: [],
    });
    expect(detectorsFired(run.findings, 'get_page')).not.toContain('D-09');
  });

  it('would flag a tool naming its own sibling, which is why no default does that', () => {
    // Passing the manifest's own tools — the default the runner deliberately
    // does not apply — turns "call list_spaces first", which honest servers
    // write constantly, into a critical finding worth forty points of risk.
    // Kept as a test rather than a comment so the reasoning stays checkable.
    const manifest = manifestOf([siblingReference, listSpaces]);
    const run = runDetectors({
      manifest,
      manifestPath: '/tmp/m.json',
      installedToolNames: manifest.tools.map((tool) => tool.name),
    });
    expect(detectorsFired(run.findings, 'get_page')).toContain('D-09');
  });

  it('numbers findings in a stable order', () => {
    const manifest = manifestOf([siblingReference, listSpaces]);
    const options = { manifest, manifestPath: '/tmp/m.json', installedToolNames: [] };
    expect(runDetectors(options).findings.map((finding) => finding.id)).toEqual(
      runDetectors(options).findings.map((finding) => finding.id),
    );
  });
});
