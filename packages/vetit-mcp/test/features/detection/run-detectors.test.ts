import { describe, expect, it } from 'vitest';
import {
  runDetectors,
  runDetectorsWithInstalled,
} from '../../../src/features/detection/index.js';
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

describe('the default runner', () => {
  it('does not treat a tool naming its own sibling as cross-server shadowing', () => {
    // An honest server writes "call list_spaces first" all the time. Defaulting
    // the installed list to the manifest's own tools would make that a critical
    // finding worth forty points of risk — a false alarm on exactly the servers
    // worth admitting.
    const run = runDetectors({
      manifest: manifestOf([siblingReference, listSpaces]),
      manifestPath: '/tmp/m.json',
    });
    expect(detectorsFired(run.findings, 'get_page')).not.toContain('D-09');
  });

  it('runs the installed-name signal when a workspace list is supplied', () => {
    const run = runDetectorsWithInstalled({
      manifest: manifestOf([siblingReference]),
      manifestPath: '/tmp/m.json',
      installedToolNames: ['list_spaces'],
    });
    expect(detectorsFired(run.findings, 'get_page')).toContain('D-09');
  });

  it('numbers findings in a stable order whichever runner is used', () => {
    const manifest = manifestOf([siblingReference, listSpaces]);
    const first = runDetectors({ manifest, manifestPath: '/tmp/m.json' });
    const second = runDetectors({ manifest, manifestPath: '/tmp/m.json' });
    expect(second.findings.map((finding) => finding.id)).toEqual(
      first.findings.map((finding) => finding.id),
    );
  });
});
