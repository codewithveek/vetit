/**
 * What a probe saw.
 *
 * Every field here is an observation, not an inference. The inferences are
 * drawn separately, in `analyse-probe.ts`, so that a reader can disagree with
 * the reasoning without doubting the record.
 *
 * The shapes are unions rather than optional values because the difference
 * between "this did not happen" and "this failed" is the whole point. A
 * missing read-back used to be reported the same way whether it was never
 * attempted or attempted and timed out, and a review that cannot tell those
 * apart cannot say what it established.
 */

/** One phase of the before/after state comparison. */
export type ReadBackPhase =
  | { readonly status: 'read'; readonly value: string }
  | { readonly status: 'not_requested' }
  | { readonly status: 'failed'; readonly reason: string };

export interface EgressHit {
  readonly method: string;
  readonly path: string;
  readonly bodySnippet: string;
  readonly containedCanary: boolean;
}

/**
 * Whether the tripwire was in a position to see anything.
 *
 * `not_performed` matters more than it looks. A collector bound to loopback
 * cannot be reached by a target on another host, so a server that steals keys
 * showed zero outgoing requests — and zero read as innocent. An observation
 * that could not have been made must never be reported as one that found
 * nothing.
 */
export type EgressObservation =
  | {
      readonly status: 'observed';
      readonly collectorUrl: string;
      readonly hits: readonly EgressHit[];
      readonly canaryReturned: boolean;
    }
  | { readonly status: 'not_performed'; readonly reason: string };

export interface ProbeObservation {
  readonly toolName: string;
  /** The endpoint actually called, derived from the manifest. */
  readonly url: string;
  /** What the tool claimed about itself before it was called. */
  readonly claimedReadOnly: boolean | undefined;
  readonly claimedDestructive: boolean | undefined;
  /** The arguments actually sent, after harmless defaults were filled in. */
  readonly argumentsSent: Readonly<Record<string, unknown>>;
  /** The tool's response, cleaned. Never raw. */
  readonly responseSnippet: string;
  readonly responseWasError: boolean;
  /** The reader the operator nominated, if any. Never guessed. */
  readonly readBackTool: string | undefined;
  readonly readBackBefore: ReadBackPhase;
  readonly readBackAfter: ReadBackPhase;
  readonly egress: EgressObservation;
  readonly durationMs: number;
}
