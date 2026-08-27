import type { DraftFinding } from '../detection/index.js';
import type { ProbeObservation } from './probing.types.js';

/**
 * Turning what a probe saw into what it means.
 *
 * Kept separate from the probing itself, and pure, for two reasons: the
 * reasoning can be tested against fixed observations without a server
 * anywhere, and a reader who disagrees with a conclusion can still trust the
 * record it was drawn from.
 *
 * Four things worth concluding, and only one of them is the famous one:
 *
 *  P-01  the tool claimed to be read-only and was *proven* to write. This is
 *        the finding no description scanner can produce, because nothing in
 *        the name, the description or the schema says it.
 *  P-02  the tool sent traffic to the tripwire collector, or sent the planted
 *        secret back. Nothing arriving proves nothing; something arriving
 *        proves theft.
 *  P-03  the tool declared nothing and was proven to write. Less damning than
 *        P-01 — it did not lie, it simply said nothing — but it settles the
 *        question §7 leaves open about how to treat silence.
 *  P-05  the response *talks* as though it wrote, and nothing confirmed it.
 *        Worth a look, not worth a rejection.
 */

/**
 * Language a response uses when something changed on the other side.
 *
 * These are the target's own words about itself, which makes them the weakest
 * evidence in the building. They used to set `observedWrite` directly, so
 * "nothing was written" and an error reading "export not completed" both
 * produced a critical P-01 against a tool that had changed nothing — while
 * the comment two lines above claimed language was never promoted to proof.
 * It is an indication now, and P-05 is where indications go.
 */
const MUTATION_PHRASES: readonly RegExp[] = [
  /\bcreated\b/i,
  /\bupdated\b/i,
  /\bdeleted\b/i,
  /\bremoved\b/i,
  /\bwritten\b/i,
  /\bwrote\b/i,
  /\bexport(?:ed)?\s+complete\b/i,
  /\bsaved\b/i,
  /\bqueued\b/i,
  /\bsent\b/i,
];

export interface WriteEvidence {
  /** True only when state observably changed. Never set by wording alone. */
  readonly observedWrite: boolean;
  /** How it was proven. Empty when it was not. */
  readonly how: readonly string[];
  /** Things worth a look that prove nothing. */
  readonly indications: readonly string[];
}

/**
 * The only proof available from outside a server you cannot instrument: state
 * read through a tool the operator nominated, before and after, differing.
 *
 * Both reads must have succeeded. A pre-read that worked and a post-read that
 * timed out is not a comparison, and used to be reported as one.
 */
export function assessWriteEvidence(observation: ProbeObservation): WriteEvidence {
  const { readBackBefore, readBackAfter } = observation;
  const how: string[] = [];
  if (
    readBackBefore.status === 'read' &&
    readBackAfter.status === 'read' &&
    readBackBefore.value !== readBackAfter.value
  ) {
    how.push(
      `state read through ${observation.readBackTool ?? 'the nominated reader'} ` +
        'changed across the call',
    );
  }

  const indications: string[] = [];
  if (MUTATION_PHRASES.some((pattern) => pattern.test(observation.responseSnippet))) {
    indications.push('the response uses the language of having changed something');
  }
  return { observedWrite: how.length > 0, how, indications };
}

function evidenceFor(observation: ProbeObservation): DraftFinding['evidence'] {
  return {
    path: `probe:${observation.toolName}`,
    jsonPointer: '/probe/response',
    snippet: observation.responseSnippet,
  };
}

function buildLabelFinding(
  observation: ProbeObservation,
  evidence: WriteEvidence,
): DraftFinding | undefined {
  if (!evidence.observedWrite) return undefined;
  const claimsReadOnly = observation.claimedReadOnly === true;
  const saysNothing = observation.claimedReadOnly === undefined;
  if (!claimsReadOnly && !saysNothing) return undefined;
  return {
    detector: claimsReadOnly ? 'P-01' : 'P-03',
    severity: claimsReadOnly ? 'critical' : 'high',
    tool: observation.toolName,
    message: claimsReadOnly
      ? `Tool is annotated readOnlyHint: true and was observed to write — ${evidence.how.join('; ')}. ` +
        'The label is false, and no amount of reading the manifest would have shown it.'
      : `Tool declares no annotations and was observed to write — ${evidence.how.join('; ')}.`,
    evidence: evidenceFor(observation),
    fix: claimsReadOnly
      ? 'Disable this tool. A server that mislabels a write cannot be trusted ' +
        'on any of its other labels either, so treat the whole manifest as ' +
        'unverified and gate every remaining tool by name.'
      : 'Gate this tool behind approval by name. Its annotations cannot be ' +
        'used to classify it, and its behaviour is a write.',
  };
}

/**
 * An indication with nothing behind it.
 *
 * Medium, not critical: the tool said it changed something and no state
 * comparison was available to check. That is worth a human's attention and is
 * not worth rejecting a server over, which is exactly the distinction the old
 * code collapsed.
 */
function buildUnverifiedWriteFinding(
  observation: ProbeObservation,
  evidence: WriteEvidence,
): DraftFinding | undefined {
  if (evidence.observedWrite || evidence.indications.length === 0) return undefined;
  if (observation.claimedReadOnly !== true && observation.claimedReadOnly !== undefined) {
    return undefined;
  }
  return {
    detector: 'P-05',
    severity: 'medium',
    tool: observation.toolName,
    message:
      'Tool claims to be read-only, and its response uses the language of ' +
      'having changed something. Nothing confirmed it either way: this is a ' +
      'reason to look, not a proven write.',
    evidence: evidenceFor(observation),
    fix:
      'Nominate a read-only tool that observes this one’s state and probe ' +
      'again with read_back_tool set. Until then the label is unverified ' +
      'rather than disproven.',
  };
}

function buildEgressFinding(observation: ProbeObservation): DraftFinding | undefined {
  const { egress } = observation;
  if (egress.status !== 'observed' || egress.hits.length === 0) return undefined;
  return {
    detector: 'P-02',
    severity: 'critical',
    tool: observation.toolName,
    message: egress.canaryReturned
      ? 'Tool sent the planted tripwire value to an outside address. This is ' +
        'credential theft, observed directly.'
      : `Tool made ${String(egress.hits.length)} outgoing request(s) ` +
        'to the tripwire collector during a single call.',
    evidence: {
      path: `probe:${observation.toolName}`,
      jsonPointer: '/probe/egress',
      snippet: egress.hits[0]?.bodySnippet ?? '',
    },
    fix:
      'Reject the server. A tool that moves data off the machine during a ' +
      'probe will do it during real use, and the probe only saw the part it ' +
      'was given somewhere to send.',
  };
}

export function analyseProbe(observation: ProbeObservation): readonly DraftFinding[] {
  const evidence = assessWriteEvidence(observation);
  return [
    buildLabelFinding(observation, evidence),
    buildUnverifiedWriteFinding(observation, evidence),
    buildEgressFinding(observation),
  ].filter((finding): finding is DraftFinding => finding !== undefined);
}
