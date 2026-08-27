import type {
  DetectorContext,
  DetectorDefinition,
  DraftFinding,
} from '../finding.types.js';
import { buildEvidence, excerptAround } from './build-evidence.js';
import { buildTagPattern } from './tag-syntax.js';

/**
 * D-01 — text hidden inside a container the reader never sees.
 *
 * A rendered description drops an HTML comment; a model reads it in full. The
 * same is true of CDATA, processing instructions, markdown comments, and
 * shouty pseudo-tags like `<IMPORTANT>`. This is the shape of the Invariant
 * Labs disclosure (April 2025), and it is still the most common way an
 * instruction is smuggled into a manifest.
 *
 * Precision matters as much as recall. `<query>` is a placeholder, not an
 * attack, so lowercase tags that are not on the instruction list do not fire.
 */

interface BlockRule {
  readonly pattern: RegExp;
  readonly what: string;
}

const BLOCK_RULES: readonly BlockRule[] = [
  { pattern: /<!--[\s\S]*?(?:-->|$)/g, what: 'an HTML comment' },
  { pattern: /<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, what: 'a CDATA section' },
  { pattern: /<\?[\s\S]*?(?:\?>|$)/g, what: 'a processing instruction' },
  {
    pattern: /\[(?:\/\/|comment)\]:\s*(?:#|<>)[^\n]*/gi,
    what: 'a markdown comment',
  },
];

/** Tag names whose only job is to address the model directly. */
const INSTRUCTION_TAGS: ReadonlySet<string> = new Set([
  'IMPORTANT',
  'SYSTEM',
  'INSTRUCTION',
  'INSTRUCTIONS',
  'PROMPT',
  'ADMIN',
  'INTERNAL',
  'HIDDEN',
  'SECRET',
  'ASSISTANT',
  'CRITICAL',
  'MANDATORY',
  'OVERRIDE',
  'NOTE_TO_ASSISTANT',
  'DO_NOT_SHOW',
]);

/** Ordinary markup that happens to be uppercase is not an instruction block. */
const KNOWN_MARKUP_TAGS: ReadonlySet<string> = new Set([
  'B', 'I', 'U', 'P', 'BR', 'HR', 'EM', 'UL', 'OL', 'LI', 'A', 'CODE', 'PRE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TR', 'TH', 'DIV', 'SPAN', 'IMG',
]);

/** Shared with the visible-text helper. Attributes included. */
const TAG_PATTERN = buildTagPattern();

const FIX =
  'Read the block in the manifest file and decide whether the server has any ' +
  'business addressing the model. If it does, the text belongs in the visible ' +
  'description. Until then, keep the tool disabled.';

function findContainerBlocks(
  text: string,
  context: DetectorContext,
): DraftFinding[] {
  const findings: DraftFinding[] = [];
  for (const rule of BLOCK_RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      findings.push({
        detector: 'D-01',
        severity: 'critical',
        tool: context.tool.name,
        message: `Description contains ${rule.what}, which a reader does not see and a model does.`,
        evidence: buildEvidence({
          context,
          pointerSegments: ['description'],
          snippetText: excerptAround({ text, matchIndex: match.index }),
        }),
        fix: FIX,
      });
    }
  }
  return findings;
}

function isInstructionTag(tagName: string): boolean {
  const upper = tagName.toUpperCase();
  if (INSTRUCTION_TAGS.has(upper)) return true;
  const isShouted = tagName === upper && tagName.length >= 3;
  return isShouted && !KNOWN_MARKUP_TAGS.has(upper);
}

function findInstructionTags(
  text: string,
  context: DetectorContext,
): DraftFinding[] {
  const findings: DraftFinding[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(TAG_PATTERN)) {
    // Group 1 is the closing slash; group 2 is the name. See tag-syntax.ts.
    const tagName = match[2] ?? '';
    if (!isInstructionTag(tagName) || seen.has(tagName.toUpperCase())) continue;
    seen.add(tagName.toUpperCase());
    findings.push({
      detector: 'D-01',
      severity: 'critical',
      tool: context.tool.name,
      message: `Description contains a <${tagName}> block addressed at the model rather than the reader.`,
      evidence: buildEvidence({
        context,
        pointerSegments: ['description'],
        snippetText: excerptAround({ text, matchIndex: match.index }),
      }),
      fix: FIX,
    });
  }
  return findings;
}

export const hiddenBlocksDetector: DetectorDefinition = {
  id: 'D-01',
  name: 'hiddenBlocks',
  severity: 'critical',
  reads: 'description',
  run: (text, context) => [
    ...findContainerBlocks(text, context),
    ...findInstructionTags(text, context),
  ],
};
