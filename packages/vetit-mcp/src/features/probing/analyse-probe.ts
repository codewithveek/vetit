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
 * There are three things worth concluding, and only one of them is the famous
 * one:
 *
 *  P-01  the tool claimed to be read-only and was observed to write. This is
 *        the finding no description scanner can produce, because nothing in
 *        the name, the description or the schema says it.
 *  P-02  the tool sent traffic to the tripwire collector, or sent the planted
 *        secret back. Nothing arriving proves nothing; something arriving
 *        proves theft.
 *  P-03  the tool declared nothing and was observed to write. Less damning
 *        than P-01 — it did not lie, it simply said nothing — but it settles
 *        the question §7 leaves open about how to treat silence.
 */

/** Language a response uses when something changed on the other side. */
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
  readonly observedWrite: boolean;
  readonly how: readonly string[];
}

/**
 * Two independent signals, and the difference between them matters.
 *
 * A read-back that changed is proof: state that was not there before is there
 * now. Mutation language in a response is only an indication — a tool can say
 * "created" about something it did not create — so it is reported as what it
 * is, and never on its own upgraded into proof.
 */
export function assessWriteEvidence(observation: ProbeObservation): WriteEvidence {
  const how: string[] = [];
  const { readBackBefore, readBackAfter } = observation;
  const readBackChanged =
    readBackBefore !== undefined &&
    readBackAfter !== undefined &&
    readBackBefore !== readBackAfter;
  if (readBackChanged) {
    how.push('state visible through a read-only tool changed across the call');
  }
  const phrase = MUTATION_PHRASES.find((pattern) =>
    pattern.test(observation.responseSnippet),
  );
  if (phrase !== undefined) {
    how.push('the response reports having changed something');
  }
  return { observedWrite: readBackChanged || phrase !== undefined, how };
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

function buildEgressFinding(observation: ProbeObservation): DraftFinding | undefined {
  if (observation.egressHits.length === 0) return undefined;
  return {
    detector: 'P-02',
    severity: 'critical',
    tool: observation.toolName,
    message: observation.canaryReturned
      ? 'Tool sent the planted tripwire value to an outside address. This is ' +
        'credential theft, observed directly.'
      : `Tool made ${String(observation.egressHits.length)} outgoing request(s) ` +
        'to the tripwire collector during a single call.',
    evidence: {
      path: `probe:${observation.toolName}`,
      jsonPointer: '/probe/egress',
      snippet: observation.egressHits[0]?.bodySnippet ?? '',
    },
    fix:
      'Reject the server. A tool that moves data off the machine during a ' +
      'probe will do it during real use, and the probe only saw the part it ' +
      'was given somewhere to send.',
  };
}

export function analyseProbe(observation: ProbeObservation): readonly DraftFinding[] {
  const evidence = assessWriteEvidence(observation);
  const findings: DraftFinding[] = [];
  const label = buildLabelFinding(observation, evidence);
  if (label !== undefined) findings.push(label);
  const egress = buildEgressFinding(observation);
  if (egress !== undefined) findings.push(egress);
  return findings;
}
