/**
 * What comes out of a review.
 *
 * Not a yes or a no. Servers are rarely wholly good or wholly bad, and a
 * verdict that can only be one of two things forces a reviewer to either
 * accept a tool they are unsure about or throw away eight useful ones to be
 * rid of a ninth. So the output is a scoped grant: a list of what this server
 * may do, with a finding id against every restriction.
 */

export type AdmissionDecision = 'reject' | 'admit_reduced' | 'admit_full';

/** How each tool was treated, and which finding decided it. */
export type ToolDisposition = 'enabled' | 'requires_approval' | 'disabled';

export interface ScopedGrant {
  readonly name: string;
  readonly decision: AdmissionDecision;
  readonly enable_tools: readonly string[];
  readonly disable_tools: readonly string[];
  readonly require_approval_for_tools: readonly string[];
  readonly preload: boolean;
  /** Tool name to the reason it was restricted, each citing a finding id. */
  readonly why: Readonly<Record<string, string>>;
  /** What the review did not cover. Never left implicit. */
  readonly not_covered: readonly string[];
}
