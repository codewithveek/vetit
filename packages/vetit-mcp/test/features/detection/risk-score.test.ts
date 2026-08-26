import { describe, expect, it } from 'vitest';
import { computeRisk } from '../../../src/features/detection/index.js';
import type { Finding, Severity } from '../../../src/features/detection/index.js';

/**
 * The score is arithmetic, and these tests exist to keep it that way. If it
 * ever stops being reproducible, a report stops being something two people can
 * argue about from the same starting point.
 */

function findings(severities: readonly Severity[]): Finding[] {
  return severities.map((severity, index) => ({
    id: `F-${String(index + 1).padStart(3, '0')}`,
    detector: 'D-01',
    severity,
    tool: 'search_docs',
    message: 'test finding',
    evidence: { path: '/tmp/m.json', jsonPointer: '/tools/0', snippet: 'x' },
    fix: 'test fix',
  }));
}

describe('the score', () => {
  it('is zero for a clean server', () => {
    const assessment = computeRisk([]);
    expect(assessment.score).toBe(0);
    expect(assessment.band).toBe('admit_full_eligible');
  });

  it('uses the published weights', () => {
    expect(computeRisk(findings(['critical'])).score).toBe(40);
    expect(computeRisk(findings(['high'])).score).toBe(15);
    expect(computeRisk(findings(['medium'])).score).toBe(5);
    expect(computeRisk(findings(['low'])).score).toBe(1);
    expect(computeRisk(findings(['info'])).score).toBe(0);
  });

  it('adds them up', () => {
    expect(computeRisk(findings(['high', 'medium', 'low'])).score).toBe(21);
  });

  it('caps at 100', () => {
    expect(computeRisk(findings(Array.from({ length: 9 }, () => 'critical'))).score)
      .toBe(100);
  });

  it('gives the same answer for the same findings, every time', () => {
    const sample = findings(['critical', 'high', 'low']);
    expect(computeRisk(sample)).toEqual(computeRisk([...sample].reverse()));
  });
});

describe('the band', () => {
  it('is full admission only when there is nothing at all', () => {
    expect(computeRisk(findings(['info'])).band).toBe('admit_full_eligible');
  });

  it('is reduced admission below 25', () => {
    expect(computeRisk(findings(['high'])).band).toBe('admit_reduced');
    expect(computeRisk(findings(['high', 'medium'])).band).toBe('admit_reduced');
  });

  it('recommends rejection at 25 and above', () => {
    expect(computeRisk(findings(['high', 'high'])).band).toBe('reject_recommended');
    expect(computeRisk(findings(['critical'])).band).toBe('reject_recommended');
  });

  it('puts the boundary exactly where the spec puts it', () => {
    expect(computeRisk(findings(['medium', 'medium', 'medium', 'medium'])).score).toBe(20);
    expect(computeRisk(findings(['medium', 'medium', 'medium', 'medium'])).band)
      .toBe('admit_reduced');
    expect(computeRisk(findings(Array.from({ length: 5 }, () => 'medium'))).band)
      .toBe('reject_recommended');
  });
});

describe('the working-out', () => {
  it('is written down so a reader can check the number', () => {
    const assessment = computeRisk(findings(['critical', 'high', 'high']));
    expect(assessment.workingOut).toBe('1×critical(40) + 2×high(15) = 70 (capped at 100)');
  });

  it('says zero rather than nothing when there are no findings', () => {
    expect(computeRisk([]).workingOut).toBe('0 = 0 (capped at 100)');
  });

  it('counts each severity separately', () => {
    const assessment = computeRisk(findings(['critical', 'low', 'low']));
    expect(assessment.counts).toEqual({ critical: 1, high: 0, medium: 0, low: 2, info: 0 });
    expect(assessment.findingCount).toBe(3);
  });
});
