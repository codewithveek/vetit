import type { ManifestTool } from '../manifest/index.js';

/**
 * One problem, with a severity, a place to look, and something to do about it.
 *
 * `evidence` is not optional. A finding a reader cannot go and check is a
 * rumour, and this project exists to replace rumours about servers with
 * evidence about them (spec §8).
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface FindingEvidence {
  /** The manifest file on disk. Absolute, so it can be opened as printed. */
  readonly path: string;
  /** RFC 6901 pointer to the exact field inside that file. */
  readonly jsonPointer: string;
  /** Cleaned by shared/redaction. Never raw. */
  readonly snippet: string;
}

export interface Finding {
  /** Assigned by the runner, in a stable order: F-001, F-002, ... */
  readonly id: string;
  /** Which detector fired: D-01 through D-10. */
  readonly detector: string;
  readonly severity: Severity;
  readonly tool: string;
  readonly message: string;
  readonly evidence: FindingEvidence;
  readonly fix: string;
}

/**
 * A finding before the runner numbers it. Detectors stay pure and order-free;
 * identity is assigned once, centrally, so the same manifest always produces
 * the same F-numbers.
 */
export type DraftFinding = Omit<Finding, 'id'>;

export interface DetectorContext {
  readonly tool: ManifestTool;
  /** Position in the stored manifest, for the JSON pointer. */
  readonly toolIndex: number;
  /** Absolute path of the manifest file the pointer applies to. */
  readonly manifestPath: string;
  /** Tool names already trusted in this workspace, for shadowing checks. */
  readonly installedToolNames: readonly string[];
}

/**
 * Text in, findings out. No files, no network, no clock, no randomness — which
 * is what makes every case testable (spec §8, §16.3).
 */
export type Detector = (
  text: string,
  context: DetectorContext,
) => readonly DraftFinding[];

export interface DetectorDefinition {
  /** "D-01" … "D-10". */
  readonly id: string;
  /** camelCase, matching the name in the spec table. */
  readonly name: string;
  readonly severity: Severity;
  /** Which field of the tool this detector reads. */
  readonly reads: 'description' | 'name' | 'schema' | 'annotations';
  readonly run: Detector;
}
