import { describe, expect, it } from 'vitest';
import { buildScopedGrant } from '../../../src/features/admission/index.js';
import { DETECTORS } from '../../../src/features/detection/index.js';
import type { Finding, Severity } from '../../../src/features/detection/index.js';
import type { ManifestTool, StoredManifest } from '../../../src/features/manifest/index.js';

/**
 * The grant is where a review turns into something that changes what an agent
 * can do, so each rule gets its own case. The interesting ones are the
 * boundaries: a clean write is still gated, and a rejected server keeps
 * disable_tools ["@all"] rather than an empty enable list.
 */

const readTool: ManifestTool = {
  name: 'search_docs',
  description: 'Searches.',
  annotations: { readOnlyHint: true, destructiveHint: false },
};

const writeTool: ManifestTool = {
  name: 'create_page',
  description: 'Creates a page.',
  annotations: { readOnlyHint: false, destructiveHint: true },
};

const unannotatedTool: ManifestTool = {
  name: 'check_environment',
  description: 'Checks the environment.',
};

function manifestOf(tools: readonly ManifestTool[]): StoredManifest {
  return {
    manifestId: '01J0000000000000000000000M',
    fetchedAt: '2026-08-26T00:00:00.000Z',
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

interface FindingOptions {
  readonly tool: string;
  readonly severity: Severity;
  readonly detector?: string;
}

function findingOn(options: FindingOptions): Finding {
  const { tool, severity } = options;
  return {
    id: 'F-001',
    detector: options.detector ?? 'D-01',
    severity,
    tool,
    message: `${severity} problem in ${tool}`,
    evidence: { path: '/tmp/m.json', jsonPointer: '/tools/0', snippet: 'x' },
    fix: 'fix it',
  };
}

/** Every static detector, as a fully reviewed manifest would record. */
const ALL_DETECTORS = DETECTORS.map((definition) => definition.id);

function grantFor(
  tools: readonly ManifestTool[],
  findings: readonly Finding[],
): ReturnType<typeof buildScopedGrant> {
  return buildScopedGrant({
    connectorName: 'target',
    manifest: manifestOf(tools),
    findings,
    detectorsRun: ALL_DETECTORS,
    notCovered: [],
  });
}

describe('a clean server', () => {
  it('is eligible for full admission', () => {
    const grant = grantFor([readTool], []);
    expect(grant.decision).toBe('admit_full');
    expect(grant.enable_tools).toEqual(['search_docs']);
    expect(grant.disable_tools).toEqual([]);
  });

  it('still gates a write behind approval', () => {
    const grant = grantFor([readTool, writeTool], []);
    expect(grant.enable_tools).toEqual(['search_docs']);
    expect(grant.require_approval_for_tools).toEqual(['create_page']);
    expect(grant.why['create_page']).toContain('Declares itself a write');
  });

  it('treats an unannotated tool as a write', () => {
    const grant = grantFor([unannotatedTool], []);
    expect(grant.require_approval_for_tools).toEqual(['check_environment']);
    expect(grant.enable_tools).toEqual([]);
  });
});

describe('findings change what a tool may do', () => {
  it('disables a tool with a critical finding', () => {
    const grant = grantFor([readTool], [findingOn({ tool: 'search_docs', severity: 'critical' })]);
    expect(grant.decision).toBe('reject');
    expect(grant.disable_tools).toEqual(['@all']);
  });

  it('gates a tool with a high finding behind approval', () => {
    const grant = grantFor(
      [readTool, writeTool],
      [findingOn({ tool: 'search_docs', severity: 'high', detector: 'D-07' })],
    );
    expect(grant.decision).toBe('admit_reduced');
    expect(grant.require_approval_for_tools).toContain('search_docs');
    expect(grant.why['search_docs']).toContain('F-001');
  });

  it('leaves a tool alone when the finding is about a different tool', () => {
    const grant = grantFor([readTool, writeTool], [findingOn({ tool: 'create_page', severity: 'high' })]);
    expect(grant.enable_tools).toEqual(['search_docs']);
  });

  it('lets a low finding pass without gating a read', () => {
    const grant = grantFor([readTool], [findingOn({ tool: 'search_docs', severity: 'low', detector: 'D-10' })]);
    expect(grant.decision).toBe('admit_reduced');
    expect(grant.enable_tools).toEqual(['search_docs']);
  });

  it('prefers the stronger restriction when a tool has both', () => {
    const grant = grantFor(
      [writeTool],
      [findingOn({ tool: 'create_page', severity: 'high' }), findingOn({ tool: 'create_page', severity: 'critical' })],
    );
    expect(grant.disable_tools).toEqual(['@all']);
  });
});

describe('a rejected server', () => {
  it('is switched off with disable_tools @all, not an empty enable list', () => {
    const grant = grantFor(
      [readTool, writeTool],
      [findingOn({ tool: 'search_docs', severity: 'critical' })],
    );
    expect(grant.disable_tools).toEqual(['@all']);
    expect(grant.enable_tools).toEqual([]);
    expect(grant.require_approval_for_tools).toEqual([]);
  });

  it('still records why each tool was restricted, so the reasoning survives', () => {
    const grant = grantFor([readTool], [findingOn({ tool: 'search_docs', severity: 'critical' })]);
    expect(grant.why['search_docs']).toContain('F-001');
  });
});

describe('the grant as a record', () => {
  it('cites a finding id for every restriction it makes', () => {
    const grant = grantFor(
      [readTool, writeTool, unannotatedTool],
      [findingOn({ tool: 'search_docs', severity: 'high' })],
    );
    for (const tool of grant.require_approval_for_tools) {
      expect(grant.why[tool]).toBeDefined();
    }
  });

  it('carries what the review could not cover', () => {
    const grant = buildScopedGrant({
      connectorName: 'target',
      manifest: manifestOf([readTool]),
      findings: [],
      detectorsRun: ALL_DETECTORS,
      notCovered: ['Behavioural verification: NOT PERFORMED — no credential supplied'],
    });
    expect(grant.not_covered).toHaveLength(1);
    expect(grant.not_covered[0]).toContain('NOT PERFORMED');
  });

  it('does not preload a server it has just reviewed', () => {
    expect(grantFor([readTool], []).preload).toBe(false);
  });

  it('proposes the same grant for the same review, every time', () => {
    const findings = [findingOn({ tool: 'search_docs', severity: 'high' })];
    expect(grantFor([readTool, writeTool], findings)).toEqual(
      grantFor([readTool, writeTool], findings),
    );
  });
});

describe('a review that did not happen is not a clean review', () => {
  function grantWithCoverage(
    detectorsRun: readonly string[],
  ): ReturnType<typeof buildScopedGrant> {
    return buildScopedGrant({
      connectorName: 'target',
      manifest: manifestOf([readTool]),
      findings: [],
      detectorsRun,
      notCovered: [],
    });
  }

  it('refuses full admission when no detector has run', () => {
    // Fetch a manifest, apply immediately: no findings, score zero, band
    // admit_full — an unchecked server released from quarantine with
    // everything enabled.
    const grant = grantWithCoverage([]);
    expect(grant.decision).toBe('admit_reduced');
  });

  it('refuses full admission when only some detectors have run', () => {
    expect(grantWithCoverage(['D-01', 'D-02']).decision).toBe('admit_reduced');
  });

  it('names the detectors that never ran', () => {
    const grant = grantWithCoverage(['D-01']);
    expect(grant.not_covered[0]).toContain('Static review: INCOMPLETE');
    expect(grant.not_covered[0]).toContain('D-02');
  });

  it('allows full admission once every detector has run and found nothing', () => {
    expect(grantWithCoverage(ALL_DETECTORS).decision).toBe('admit_full');
    expect(grantWithCoverage(ALL_DETECTORS).not_covered).toEqual([]);
  });

  it('puts derived gaps ahead of whatever the caller volunteered', () => {
    const grant = buildScopedGrant({
      connectorName: 'target',
      manifest: manifestOf([readTool]),
      findings: [],
      detectorsRun: [],
      notCovered: ['Something the caller knew'],
    });
    expect(grant.not_covered[0]).toContain('Static review: INCOMPLETE');
    expect(grant.not_covered.at(-1)).toBe('Something the caller knew');
  });
});

describe('entries the review could not read', () => {
  function grantWithUnparseable(count: number): ReturnType<typeof buildScopedGrant> {
    return buildScopedGrant({
      connectorName: 'target',
      manifest: { ...manifestOf([readTool]), unparseableToolCount: count },
      findings: [],
      detectorsRun: ALL_DETECTORS,
      notCovered: [],
    });
  }

  it('refuses full admission when an entry could not be parsed', () => {
    // An entry nobody could read is an entry nobody reviewed, so the tool
    // surface was never fully seen.
    expect(grantWithUnparseable(1).decision).toBe('admit_reduced');
  });

  it('records how many were unreadable', () => {
    expect(grantWithUnparseable(3).not_covered[0]).toContain('3 entries');
  });

  it('allows full admission when every entry parsed', () => {
    expect(grantWithUnparseable(0).decision).toBe('admit_full');
  });
});

describe('a manifest with duplicate tool names', () => {
  function grantWithDuplicates(): ReturnType<typeof buildScopedGrant> {
    const duplicated: ManifestTool = { ...writeTool, name: 'search_docs' };
    return buildScopedGrant({
      connectorName: 'target',
      manifest: {
        ...manifestOf([readTool, duplicated]),
        duplicateToolNames: ['search_docs'],
      },
      findings: [],
      detectorsRun: ALL_DETECTORS,
      notCovered: [],
    });
  }

  it('is rejected, because a name-keyed grant cannot tell the two apart', () => {
    // One name in both enable_tools and require_approval_for_tools is an
    // ambiguous policy, and whichever wins, the other tool inherits it.
    expect(grantWithDuplicates().decision).toBe('reject');
    expect(grantWithDuplicates().disable_tools).toEqual(['@all']);
  });

  it('says which name was ambiguous', () => {
    expect(grantWithDuplicates().not_covered.join(' ')).toContain('search_docs');
  });

  it('never emits a name in more than one list', () => {
    const grant = grantWithDuplicates();
    const all = [
      ...grant.enable_tools,
      ...grant.disable_tools,
      ...grant.require_approval_for_tools,
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});
