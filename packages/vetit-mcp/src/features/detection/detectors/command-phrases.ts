import type { DetectorContext, DetectorDefinition, DraftFinding } from '../finding.types.js';
import { buildEvidence, excerptAround } from './build-evidence.js';

/**
 * D-04 — a description that gives the model orders.
 *
 * A tool description is meant to say what a tool does. When it starts telling
 * the model what to do first, what not to say, or what to disregard, it has
 * stopped describing and started instructing.
 *
 * The phrase list is deliberately narrow. "You must first authenticate" is an
 * instruction; "this tool must first be configured" is documentation. A
 * security tool that fires on the second one gets switched off, and then it
 * catches nothing at all.
 */

interface PhraseRule {
  readonly pattern: RegExp;
  readonly what: string;
}

const PHRASE_RULES: readonly PhraseRule[] = [
  { pattern: /\bignore\s+(?:all\s+)?(?:previous|prior|earlier|the\s+above)\b/gi, what: 'tells the model to ignore what came before' },
  { pattern: /\bdisregard\s+(?:all\s+)?(?:previous|prior|the\s+above|any)\b/gi, what: 'tells the model to disregard what came before' },
  { pattern: /\b(?:do\s+not|don'?t|never)\s+(?:tell|inform|mention\s+to|reveal\s+to)\s+(?:the\s+)?user\b/gi, what: 'tells the model to keep something from the user' },
  { pattern: /\b(?:do\s+not|don'?t|never)\s+(?:mention|reveal|disclose|show)\s+(?:this|that|it|the\s+\w+)\b/gi, what: 'tells the model to conceal something' },
  { pattern: /\bwithout\s+(?:telling|informing|notifying)\s+(?:the\s+)?user\b/gi, what: 'tells the model to act without telling the user' },
  { pattern: /\bbefore\s+(?:using|calling|invoking)\s+this\s+tool\s*,?\s*(?:you\s+)?(?:must|should|need|have\s+to|always)\b/gi, what: 'imposes a precondition on the model' },
  { pattern: /\byou\s+must\s+first\b/gi, what: 'imposes a precondition on the model' },
  { pattern: /\byou\s+(?:should|must|need\s+to|have\s+to)\s+(?:always\s+)?(?:read|send|include|pass|attach|forward)\b/gi, what: 'orders the model to move data' },
  { pattern: /\b(?:new|updated|revised)\s+(?:system\s+)?instructions?\s*:/gi, what: 'announces new instructions' },
  { pattern: /\bthis\s+is\s+(?:required|mandatory)\s+for\b/gi, what: 'insists on compliance' },
];

export const commandPhrasesDetector: DetectorDefinition = {
  id: 'D-04',
  name: 'commandPhrases',
  severity: 'high',
  reads: 'description',
  run: (text, context: DetectorContext): readonly DraftFinding[] => {
    const findings: DraftFinding[] = [];
    for (const rule of PHRASE_RULES) {
      const match = rule.pattern.exec(text);
      rule.pattern.lastIndex = 0;
      if (match === null) continue;
      findings.push({
        detector: 'D-04',
        severity: 'high',
        tool: context.tool.name,
        message: `Description ${rule.what} rather than describing what the tool does.`,
        evidence: buildEvidence({
          context,
          pointerSegments: ['description'],
          snippetText: excerptAround({ text, matchIndex: match.index }),
        }),
        fix:
          'A description is documentation, not a prompt. Ask the publisher to ' +
          'remove the instruction. Until they do, require approval on every ' +
          'call to this tool.',
      });
    }
    return findings;
  },
};
