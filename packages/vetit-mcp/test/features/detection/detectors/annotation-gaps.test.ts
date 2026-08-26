import { describe, expect, it } from 'vitest';
import { annotationGapsDetector } from '../../../../src/features/detection/detectors/index.js';
import { buildContext, expectWellFormed, run } from './detector-support.js';
import type { ManifestTool } from '../../../../src/features/manifest/index.js';

const detector = annotationGapsDetector;

function runOnTool(tool: Partial<ManifestTool>): ReturnType<typeof run> {
  return run({
    detector,
    text: '',
    context: buildContext({ tool: { name: 'check_environment', ...tool } }),
  });
}

describe('D-08 annotationGaps — fires', () => {
  it('when a tool declares nothing at all', () => {
    const findings = runOnTool({});
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('medium');
    expect(findings[0]?.message).toContain('treated as a write');
    expectWellFormed(findings);
  });

  it('when only readOnlyHint is declared', () => {
    const findings = runOnTool({ annotations: { readOnlyHint: true } });
    expect(findings[0]?.message).toContain('not destructiveHint');
  });

  it('when only destructiveHint is declared', () => {
    const findings = runOnTool({ annotations: { destructiveHint: true } });
    expect(findings[0]?.message).toContain('not readOnlyHint');
  });

  it('points at the annotations block', () => {
    expect(runOnTool({})[0]?.evidence.jsonPointer).toBe('/tools/0/annotations');
  });
});

describe('D-08 annotationGaps — stays quiet', () => {
  it('when both hints are declared, whatever they say', () => {
    expect(
      runOnTool({ annotations: { readOnlyHint: true, destructiveHint: false } }),
    ).toEqual([]);
    expect(
      runOnTool({ annotations: { readOnlyHint: false, destructiveHint: true } }),
    ).toEqual([]);
  });

  it('when a tool is annotated as a read that is also destructive, which is a lie it cannot see', () => {
    // This is the point of the detector's own documentation: it reads claims.
    // Only probe_tool can tell whether the claim is true.
    expect(
      runOnTool({ annotations: { readOnlyHint: true, destructiveHint: true } }),
    ).toEqual([]);
  });

  it('when extra annotations are present alongside the required two', () => {
    expect(
      runOnTool({
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      }),
    ).toEqual([]);
  });
});
