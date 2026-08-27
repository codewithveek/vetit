import { describe, expect, it } from 'vitest';
import {
  analyseProbe,
  assessWriteEvidence,
} from '../../../src/features/probing/index.js';
import type {
  EgressHit,
  ProbeObservation,
} from '../../../src/features/probing/index.js';

/**
 * The reasoning, tested without a server anywhere. That separation is the
 * point of keeping analysis apart from probing: a reader can disagree with a
 * conclusion here without having to doubt the record it came from.
 */

function observation(overrides: Partial<ProbeObservation> = {}): ProbeObservation {
  return {
    toolName: 'export_all',
    url: 'http://127.0.0.1:1/mcp',
    claimedReadOnly: true,
    claimedDestructive: false,
    argumentsSent: {},
    responseSnippet: '⟦UNTRUSTED_TEXT: Nothing happened. ⟧',
    responseWasError: false,
    readBackTool: 'list_spaces',
    readBackBefore: { status: 'read', value: 'handbook\nrunbooks' },
    readBackAfter: { status: 'read', value: 'handbook\nrunbooks' },
    egress: { status: 'not_performed', reason: 'no reachable collector' },
    durationMs: 12,
    ...overrides,
  };
}

function hit(containedCanary: boolean): EgressHit {
  return {
    method: 'POST',
    path: '/collect',
    bodySnippet: '⟦UNTRUSTED_TEXT: x ⟧',
    containedCanary,
  };
}

describe('assessWriteEvidence — what counts as proof', () => {
  it('treats a changed read-back as proof', () => {
    const evidence = assessWriteEvidence(
      observation({ readBackAfter: { status: 'read', value: 'handbook\narchive-1' } }),
    );
    expect(evidence.observedWrite).toBe(true);
    expect(evidence.how[0]).toContain('changed across the call');
  });

  it('finds nothing when the state did not change', () => {
    expect(assessWriteEvidence(observation()).observedWrite).toBe(false);
  });

  it('does not treat a missing read-back as a changed one', () => {
    const evidence = assessWriteEvidence(
      observation({
        readBackBefore: { status: 'not_requested' },
        readBackAfter: { status: 'not_requested' },
      }),
    );
    expect(evidence.observedWrite).toBe(false);
  });

  it('refuses to compare when only one of the two reads succeeded', () => {
    // A pre-read that worked and a post-read that timed out is not a
    // comparison, and used to be reported as one.
    const evidence = assessWriteEvidence(
      observation({ readBackAfter: { status: 'failed', reason: 'timeout' } }),
    );
    expect(evidence.observedWrite).toBe(false);
    expect(evidence.how).toEqual([]);
  });
});

describe('assessWriteEvidence — what is only an indication', () => {
  it('records mutation language without calling it proof', () => {
    const evidence = assessWriteEvidence(
      observation({ responseSnippet: '⟦UNTRUSTED_TEXT: Export complete. ⟧' }),
    );
    expect(evidence.observedWrite).toBe(false);
    expect(evidence.indications).toHaveLength(1);
  });

  it.each([
    'Nothing was written.',
    'Export not completed.',
    'No pages were created.',
    'Error: could not save.',
  ])('does not turn %j into a proven write', (text) => {
    // These all match a mutation keyword and all describe a tool that changed
    // nothing. They used to produce a critical P-01.
    const evidence = assessWriteEvidence(
      observation({ responseSnippet: `⟦UNTRUSTED_TEXT: ${text} ⟧` }),
    );
    expect(evidence.observedWrite).toBe(false);
  });

  it('reports both when state changed and the wording agrees', () => {
    const evidence = assessWriteEvidence(
      observation({
        readBackAfter: { status: 'read', value: 'handbook\narchive-1' },
        responseSnippet: '⟦UNTRUSTED_TEXT: Export complete. ⟧',
      }),
    );
    expect(evidence.observedWrite).toBe(true);
    expect(evidence.indications).toHaveLength(1);
  });
});

describe('the lying label', () => {
  it('is critical when a tool claims read-only and was proven to write', () => {
    const findings = analyseProbe(
      observation({ readBackAfter: { status: 'read', value: 'handbook\narchive-1' } }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detector).toBe('P-01');
    expect(findings[0]?.severity).toBe('critical');
    expect(findings[0]?.message).toContain('The label is false');
  });

  it('is only high when the tool never claimed anything', () => {
    const findings = analyseProbe(
      observation({
        claimedReadOnly: undefined,
        claimedDestructive: undefined,
        readBackAfter: { status: 'read', value: 'changed' },
      }),
    );
    expect(findings[0]?.detector).toBe('P-03');
    expect(findings[0]?.severity).toBe('high');
  });

  it('says nothing about a tool that admitted it writes and then wrote', () => {
    const findings = analyseProbe(
      observation({
        claimedReadOnly: false,
        claimedDestructive: true,
        readBackAfter: { status: 'read', value: 'changed' },
      }),
    );
    expect(findings).toEqual([]);
  });

  it('says nothing about a read-only tool that read', () => {
    expect(analyseProbe(observation())).toEqual([]);
  });
});

describe('an unverified write', () => {
  it('is medium, not critical, when only the wording suggests it', () => {
    const findings = analyseProbe(
      observation({
        responseSnippet: '⟦UNTRUSTED_TEXT: Export complete. ⟧',
        readBackBefore: { status: 'not_requested' },
        readBackAfter: { status: 'not_requested' },
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detector).toBe('P-05');
    expect(findings[0]?.severity).toBe('medium');
    expect(findings[0]?.message).toContain('not a proven write');
  });

  it('does not put a read-only claim in the mouth of a tool that made none', () => {
    const findings = analyseProbe(
      observation({
        claimedReadOnly: undefined,
        claimedDestructive: undefined,
        responseSnippet: '⟦UNTRUSTED_TEXT: Created page-4. ⟧',
        readBackBefore: { status: 'not_requested' },
        readBackAfter: { status: 'not_requested' },
      }),
    );
    expect(findings[0]?.detector).toBe('P-05');
    expect(findings[0]?.message).toContain('declares no annotations');
    expect(findings[0]?.message).not.toContain('claims to be read-only');
  });

  it('tells the reader how to turn it into proof', () => {
    const findings = analyseProbe(
      observation({
        responseSnippet: '⟦UNTRUSTED_TEXT: Created page-4. ⟧',
        readBackBefore: { status: 'not_requested' },
        readBackAfter: { status: 'not_requested' },
      }),
    );
    expect(findings[0]?.fix).toContain('read_back_tool');
  });

  it('gives way to P-01 once the write is proven', () => {
    const findings = analyseProbe(
      observation({
        responseSnippet: '⟦UNTRUSTED_TEXT: Export complete. ⟧',
        readBackAfter: { status: 'read', value: 'changed' },
      }),
    );
    expect(findings.map((finding) => finding.detector)).toEqual(['P-01']);
  });

  it('says nothing about a tool that admits it writes', () => {
    const findings = analyseProbe(
      observation({
        claimedReadOnly: false,
        claimedDestructive: true,
        responseSnippet: '⟦UNTRUSTED_TEXT: Created page-4. ⟧',
      }),
    );
    expect(findings).toEqual([]);
  });
});

describe('the tripwire', () => {
  it('is critical when the planted value comes back', () => {
    const findings = analyseProbe(
      observation({
        egress: {
          status: 'observed',
          collectorUrl: 'http://127.0.0.1:9/collect',
          hits: [hit(true)],
          canaryReturned: true,
        },
      }),
    );
    expect(findings[0]?.detector).toBe('P-02');
    expect(findings[0]?.message).toContain('credential theft');
  });

  it('is still critical when traffic arrived without the planted value', () => {
    const findings = analyseProbe(
      observation({
        egress: {
          status: 'observed',
          collectorUrl: 'http://127.0.0.1:9/collect',
          hits: [hit(false)],
          canaryReturned: false,
        },
      }),
    );
    expect(findings[0]?.detector).toBe('P-02');
    expect(findings[0]?.message).toContain('outgoing request');
  });

  it('says nothing when the collector could not have been reached', () => {
    // Silence from a collector the target cannot see is not evidence of
    // anything, and must not read as a clean result.
    const findings = analyseProbe(
      observation({
        egress: { status: 'not_performed', reason: 'target is not on this host' },
      }),
    );
    expect(findings).toEqual([]);
  });

  it('reports the label lie and the theft separately', () => {
    const findings = analyseProbe(
      observation({
        readBackAfter: { status: 'read', value: 'changed' },
        egress: {
          status: 'observed',
          collectorUrl: 'http://127.0.0.1:9/collect',
          hits: [hit(true)],
          canaryReturned: true,
        },
      }),
    );
    expect(findings.map((finding) => finding.detector)).toEqual(['P-01', 'P-02']);
  });
});
