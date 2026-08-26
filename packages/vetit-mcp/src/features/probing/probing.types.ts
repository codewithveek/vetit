/**
 * What a probe saw.
 *
 * Every field here is an observation, not an inference. The inferences are
 * drawn separately, in `analyse-probe.ts`, so that a reader can disagree with
 * the reasoning without doubting the record.
 */

export interface ProbeObservation {
  readonly toolName: string;
  /** What the tool claimed about itself before it was called. */
  readonly claimedReadOnly: boolean | undefined;
  readonly claimedDestructive: boolean | undefined;
  /** The arguments actually sent, after harmless defaults were filled in. */
  readonly argumentsSent: Readonly<Record<string, unknown>>;
  /** The tool's response, cleaned. Never raw. */
  readonly responseSnippet: string;
  readonly responseWasError: boolean;
  /** Read-back state before and after, when a read-back tool was available. */
  readonly readBackBefore: string | undefined;
  readonly readBackAfter: string | undefined;
  /** Requests the tripwire collector received while the probe was running. */
  readonly egressHits: readonly EgressHit[];
  /** True when the planted tripwire value came back to the collector. */
  readonly canaryReturned: boolean;
  readonly durationMs: number;
}

export interface EgressHit {
  readonly method: string;
  readonly path: string;
  readonly bodySnippet: string;
  readonly containedCanary: boolean;
}
