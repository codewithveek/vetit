import { computeRisk, DETECTORS, type Finding } from '../detection/index.js';
import type { ManifestTool, StoredManifest } from '../manifest/index.js';
import type {
  AdmissionDecision,
  ScopedGrant,
  ToolDisposition,
} from './admission.types.js';

/**
 * Turning findings into a permission list.
 *
 * Pure: manifest and findings in, grant out. No network, no clock — so the
 * same review always proposes the same grant, and a human comparing two runs
 * is comparing the servers rather than the weather.
 *
 * The rules, in order, and each one is a claim someone can argue with:
 *
 *  1. a critical finding disables the tool. Critical means an instruction
 *     aimed at the model, a hidden character, or a reference to somebody
 *     else's tools. None of those has an innocent reading.
 *  2. a high finding puts the tool behind approval. High means suspicious,
 *     not proven, and a human looking at one call is the right resolution.
 *  3. a tool that writes goes behind approval whatever its findings, because
 *     the cost of being wrong about a write is not the cost of being wrong
 *     about a read.
 *  4. a tool that declares nothing counts as a write, per §7.
 *  5. everything else is enabled.
 */

/** Every static detector must have run before a server can be admitted. */
const MANDATORY_DETECTORS: readonly string[] = DETECTORS.map(
  (definition) => definition.id,
);

/** A name may appear in exactly one list, once. */
function unique(names: readonly string[]): string[] {
  return [...new Set(names)];
}

const CRITICAL_SEVERITIES: ReadonlySet<string> = new Set(['critical']);
const APPROVAL_SEVERITIES: ReadonlySet<string> = new Set(['high']);

function isDeclaredWrite(tool: ManifestTool): boolean {
  const annotations = tool.annotations;
  if (annotations?.destructiveHint === true) return true;
  // Silence is a write. See check_annotations for why this is not pedantry.
  return annotations?.readOnlyHint !== true;
}

interface ToolVerdict {
  readonly disposition: ToolDisposition;
  readonly reason: string | undefined;
}

function summarise(finding: Finding): string {
  return `${finding.id} — ${finding.message}`;
}

function decideForTool(tool: ManifestTool, findings: readonly Finding[]): ToolVerdict {
  const critical = findings.find((finding) => CRITICAL_SEVERITIES.has(finding.severity));
  if (critical !== undefined) {
    return { disposition: 'disabled', reason: summarise(critical) };
  }
  const high = findings.find((finding) => APPROVAL_SEVERITIES.has(finding.severity));
  if (high !== undefined) {
    return { disposition: 'requires_approval', reason: summarise(high) };
  }
  if (isDeclaredWrite(tool)) {
    const annotationFinding = findings.find((finding) => finding.detector === 'D-08');
    return {
      disposition: 'requires_approval',
      reason:
        annotationFinding === undefined
          ? 'Declares itself a write. Gated by name, not by label — this ' +
            'review does not rely on a server’s own annotations.'
          : summarise(annotationFinding),
    };
  }
  return { disposition: 'enabled', reason: undefined };
}

function decideFromFindings(findings: readonly Finding[]): AdmissionDecision {
  const band = computeRisk(findings).band;
  switch (band) {
    case 'reject_recommended': {
      return 'reject';
    }
    case 'admit_full_eligible': {
      return 'admit_full';
    }
    case 'admit_reduced': {
      return 'admit_reduced';
    }
  }
}

/**
 * Reasons the review is not complete enough to speak for the server.
 *
 * Derived from what is recorded, never from what the caller said. A caller
 * supplying an empty `not_covered` was previously taken as evidence that
 * nothing was uncovered, which is the opposite of how absence of evidence
 * works.
 */
function describeGaps(options: BuildGrantOptions): string[] {
  const gaps: string[] = [];
  const missing = MANDATORY_DETECTORS.filter(
    (detector) => !options.detectorsRun.includes(detector),
  );
  if (missing.length > 0) {
    gaps.push(
      `Static review: INCOMPLETE — ${missing.join(', ')} never ran against this manifest.`,
    );
  }
  if (options.manifest.unparseableToolCount > 0) {
    gaps.push(
      `Tool surface: INCOMPLETE — ${String(options.manifest.unparseableToolCount)} ` +
        'entries could not be read as tools and were therefore never reviewed.',
    );
  }
  if (options.manifest.duplicateToolNames.length > 0) {
    gaps.push(
      'Tool identity: AMBIGUOUS — ' +
        `${options.manifest.duplicateToolNames.join(', ')} ` +
        'each name more than one tool, and a permission list keyed by name ' +
        'cannot tell them apart.',
    );
  }
  return gaps;
}

/**
 * What the review can honestly conclude, given what it actually did.
 *
 * Three things override the findings-based decision, and all three are about
 * the review rather than the server:
 *
 *  - a duplicated tool name makes the grant unenforceable. Two tools, one
 *    name, and a permission list that can only say the name: whichever policy
 *    is written, the other tool inherits it. Rejected rather than guessed.
 *  - an entry the review could not parse is an entry nobody reviewed, so the
 *    surface was never fully seen and `admit_full` is not available.
 *  - a detector that never ran is a question nobody asked. An empty findings
 *    list used to mean both "nothing was found" and "nothing was looked for",
 *    and the second was being released from quarantine as though it were the
 *    first.
 */
function decideForServer(options: BuildGrantOptions): AdmissionDecision {
  if (options.manifest.duplicateToolNames.length > 0) return 'reject';
  const fromFindings = decideFromFindings(options.findings);
  if (fromFindings !== 'admit_full') return fromFindings;
  const isFullyReviewed =
    describeGaps(options).length === 0 && options.manifest.unparseableToolCount === 0;
  return isFullyReviewed ? 'admit_full' : 'admit_reduced';
}

export interface BuildGrantOptions {
  readonly connectorName: string;
  readonly manifest: StoredManifest;
  readonly findings: readonly Finding[];
  /** Which detectors actually ran. Read from the record, not from the caller. */
  readonly detectorsRun: readonly string[];
  /** What the caller knows Vetit could not check. Added to the derived gaps. */
  readonly notCovered: readonly string[];
}

interface GroupedTools {
  readonly enabled: string[];
  readonly disabled: string[];
  readonly requiresApproval: string[];
  readonly why: Record<string, string>;
}

function groupTools(options: BuildGrantOptions): GroupedTools {
  const grouped: GroupedTools = {
    enabled: [],
    disabled: [],
    requiresApproval: [],
    why: {},
  };
  for (const tool of options.manifest.tools) {
    const forTool = options.findings.filter((finding) => finding.tool === tool.name);
    const verdict = decideForTool(tool, forTool);
    if (verdict.reason !== undefined) grouped.why[tool.name] = verdict.reason;
    if (verdict.disposition === 'disabled') grouped.disabled.push(tool.name);
    else if (verdict.disposition === 'requires_approval') {
      grouped.requiresApproval.push(tool.name);
    } else grouped.enabled.push(tool.name);
  }
  return grouped;
}

/**
 * A rejected server keeps `disable_tools: ["@all"]`.
 *
 * Not `enable_tools: []` — when `enable_tools` is absent it falls back to
 * `["@all"]`, and `disable_tools` is subtracted from whatever is enabled, so
 * disabling everything is the only phrasing that leaves no room for doubt
 * (spec §6).
 */
export function buildScopedGrant(options: BuildGrantOptions): ScopedGrant {
  const decision = decideForServer(options);
  const grouped = groupTools(options);
  const isRejected = decision === 'reject';
  return {
    name: options.connectorName,
    decision,
    enable_tools: isRejected ? [] : unique(grouped.enabled),
    disable_tools: isRejected ? ['@all'] : unique(grouped.disabled),
    require_approval_for_tools: isRejected ? [] : unique(grouped.requiresApproval),
    preload: false,
    why: grouped.why,
    // Derived gaps first, then whatever the caller knew that Vetit could not.
    not_covered: [...describeGaps(options), ...options.notCovered],
  };
}
