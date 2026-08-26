import { describe, expect, it } from 'vitest';
import {
  analyseProbe,
  assessWriteEvidence,
} from '../../../src/features/probing/index.js';
import type { ProbeObservation } from '../../../src/features/probing/index.js';

/**
 * The reasoning, tested without a server anywhere. That separation is the
 * point of keeping analysis apart from probing: a reader can disagree with a
 * conclusion here without having to doubt the record it came from.
 */

function observation(overrides: Partial<ProbeObservation> = {}): ProbeObservation {
  return {
    toolName: 'export_all',
    claimedReadOnly: true,
    claimedDestructive: false,
    argumentsSent: {},
    responseSnippet: '⟦UNTRUSTED_TEXT: Nothing happened. ⟧',
    responseWasError: false,
    readBackBefore: 'handbook\nrunbooks',
    readBackAfter: 'handbook\nrunbooks',
    egressHits: [],
    canaryReturned: false,
    durationMs: 12,
    ...overrides,
  };
}

describe('assessWriteEvidence', () => {
  it('treats a changed read-back as proof', () => {
    const evidence = assessWriteEvidence(
      observation({ readBackAfter: 'handbook\nrunbooks\narchive-1' }),
    );
    expect(evidence.observedWrite).toBe(true);
    expect(evidence.how[0]).toContain('changed across the call');
  });

  it('treats mutation language as an indication, and says which it is', () => {
    const evidence = assessWriteEvidence(
      observation({ responseSnippet: '⟦UNTRUSTED_TEXT: Export complete. ⟧' }),
    );
    expect(evidence.observedWrite).toBe(true);
    expect(evidence.how).toEqual(['the response reports having changed something']);
  });

  it('reports both signals when both fired', () => {
    const evidence = assessWriteEvidence(
      observation({
        readBackAfter: 'handbook\nrunbooks\narchive-1',
        responseSnippet: '⟦UNTRUSTED_TEXT: Export complete. ⟧',
      }),
    );
    expect(evidence.how).toHaveLength(2);
  });

  it('finds nothing when nothing changed and nothing was claimed', () => {
    expect(assessWriteEvidence(observation()).observedWrite).toBe(false);
  });

  it('does not treat a missing read-back as a changed one', () => {
    const evidence = assessWriteEvidence(
      observation({ readBackBefore: undefined, readBackAfter: undefined }),
    );
    expect(evidence.observedWrite).toBe(false);
  });
});

describe('the lying label', () => {
  it('is critical when a tool claims read-only and was seen to write', () => {
    const findings = analyseProbe(
      observation({ readBackAfter: 'handbook\nrunbooks\narchive-1' }),
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
        readBackAfter: 'changed',
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
        readBackAfter: 'changed',
      }),
    );
    expect(findings).toEqual([]);
  });

  it('says nothing about a read-only tool that read', () => {
    expect(analyseProbe(observation())).toEqual([]);
  });
});

describe('the tripwire', () => {
  it('is critical when the planted value comes back', () => {
    const findings = analyseProbe(
      observation({
        egressHits: [
          { method: 'POST', path: '/collect', bodySnippet: '⟦UNTRUSTED_TEXT: x ⟧', containedCanary: true },
        ],
        canaryReturned: true,
      }),
    );
    expect(findings[0]?.detector).toBe('P-02');
    expect(findings[0]?.message).toContain('credential theft');
  });

  it('is still critical when traffic arrived without the planted value', () => {
    const findings = analyseProbe(
      observation({
        egressHits: [
          { method: 'POST', path: '/collect', bodySnippet: '⟦UNTRUSTED_TEXT: x ⟧', containedCanary: false },
        ],
      }),
    );
    expect(findings[0]?.detector).toBe('P-02');
    expect(findings[0]?.message).toContain('outgoing request');
  });

  it('reports the label lie and the theft separately', () => {
    const findings = analyseProbe(
      observation({
        readBackAfter: 'changed',
        egressHits: [
          { method: 'POST', path: '/c', bodySnippet: '⟦UNTRUSTED_TEXT: x ⟧', containedCanary: true },
        ],
        canaryReturned: true,
      }),
    );
    expect(findings.map((finding) => finding.detector)).toEqual(['P-01', 'P-02']);
  });
});
