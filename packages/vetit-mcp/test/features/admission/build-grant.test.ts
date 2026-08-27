import { describe, expect, it } from 'vitest';
import { buildScopedGrant } from '../../../src/features/admission/index.js';
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

function grantFor(
  tools: readonly ManifestTool[],
  findings: readonly Finding[],
): ReturnType<typeof buildScopedGrant> {
  return buildScopedGrant({
    connectorName: 'target',
    manifest: manifestOf(tools),
    findings,
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
