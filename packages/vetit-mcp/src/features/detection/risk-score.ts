import type { Finding, Severity } from './finding.types.js';

/**
 * Arithmetic, not judgement.
 *
 * Spec §8: the same findings always give the same number. No model is asked
 * what it thinks a server is worth, because a score that moves between runs is
 * a score nobody can act on or argue with.
 *
 * The number is a recommendation. The human decides — which is why the band
 * for a clean server is "eligible for full admission", not "admitted".
 */

const SEVERITY_WEIGHTS: Readonly<Record<Severity, number>> = {
  critical: 40,
  high: 15,
  medium: 5,
  low: 1,
  info: 0,
};

const MAXIMUM_SCORE = 100;

/** Fixed order, so the working-out reads the same way every time. */
const SEVERITY_ORDER: readonly Severity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
];

export type RiskBand = 'admit_full_eligible' | 'admit_reduced' | 'reject_recommended';

export interface SeverityCounts {
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly info: number;
}

export interface RiskAssessment {
  readonly score: number;
  readonly band: RiskBand;
  readonly counts: SeverityCounts;
  readonly findingCount: number;
  /** The arithmetic, written out, so a reader can check the number. */
  readonly workingOut: string;
}

export function countBySeverity(findings: readonly Finding[]): SeverityCounts {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

function classify(score: number): RiskBand {
  if (score === 0) return 'admit_full_eligible';
  if (score < 25) return 'admit_reduced';
  return 'reject_recommended';
}

function describeWorkingOut(counts: SeverityCounts, score: number): string {
  const terms = SEVERITY_ORDER
    .filter((severity) => counts[severity] > 0)
    .map(
      (severity) =>
        `${String(counts[severity])}×${severity}(${String(SEVERITY_WEIGHTS[severity])})`,
    );
  const sum = terms.length > 0 ? terms.join(' + ') : '0';
  return `${sum} = ${String(score)} (capped at ${String(MAXIMUM_SCORE)})`;
}

export function computeRisk(findings: readonly Finding[]): RiskAssessment {
  const counts = countBySeverity(findings);
  const raw = SEVERITY_ORDER.reduce(
    (total, severity) => total + counts[severity] * SEVERITY_WEIGHTS[severity],
    0,
  );
  const score = Math.min(MAXIMUM_SCORE, raw);
  return {
    score,
    band: classify(score),
    counts,
    findingCount: findings.length,
    workingOut: describeWorkingOut(counts, score),
  };
}
