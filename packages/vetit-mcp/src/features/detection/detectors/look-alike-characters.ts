import type { DetectorContext, DetectorDefinition, DraftFinding } from '../finding.types.js';
import { buildEvidence } from './build-evidence.js';

/**
 * D-03 — a tool name that reads as one thing and is another.
 *
 * `sendmеssage` with a Cyrillic `е` is a different string from `sendmessage`,
 * and no amount of careful reading will tell them apart. Used to impersonate a
 * tool a workspace already trusts.
 *
 * Two signals, either of which fires:
 *
 *  - a character from the known confusable table, which is the attack itself
 *  - a name that mixes ASCII letters with letters from another script, which
 *    is the shape the attack takes even when the character is not in the table
 *
 * A name written entirely in another script is not flagged. It is unusual, but
 * it impersonates nothing, and calling it an attack would be crying wolf.
 */

/** Characters that render as an ASCII letter but are not one. */
const CONFUSABLES: ReadonlyMap<string, string> = new Map([
  ['\u0430', 'a'], ['\u0435', 'e'], ['\u043E', 'o'], ['\u0440', 'p'],
  ['\u0441', 'c'], ['\u0443', 'y'], ['\u0445', 'x'], ['\u0456', 'i'],
  ['\u0455', 's'], ['\u0458', 'j'], ['\u04BB', 'h'], ['\u0501', 'd'],
  ['\u03BF', 'o'], ['\u03B1', 'a'], ['\u03BD', 'v'], ['\u03C1', 'p'],
  ['\u03C5', 'u'], ['\u0261', 'g'], ['\u1D0F', 'o'], ['\uFF41', 'a'],
]);

const ASCII_LETTER = /[A-Za-z]/;
const NON_ASCII_LETTER = /\P{ASCII}/u;

interface NameFinding {
  readonly message: string;
  readonly snippetText: string;
}

function describeConfusables(name: string): NameFinding | undefined {
  const hits = Array.from(name).filter((character) => CONFUSABLES.has(character));
  if (hits.length === 0) return undefined;
  const detail = hits
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      const hex = `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
      return `${hex} reads as "${CONFUSABLES.get(character) ?? '?'}"`;
    })
    .join(', ');
  return {
    message: `Tool name uses look-alike characters from another alphabet: ${detail}.`,
    snippetText: name,
  };
}

function describeMixedScript(name: string): NameFinding | undefined {
  if (!ASCII_LETTER.test(name) || !NON_ASCII_LETTER.test(name)) return undefined;
  return {
    message:
      'Tool name mixes ASCII letters with letters from another script, which ' +
      'is how a name is made to read like one a workspace already trusts.',
    snippetText: name,
  };
}

export const lookAlikeCharactersDetector: DetectorDefinition = {
  id: 'D-03',
  name: 'lookAlikeCharacters',
  severity: 'high',
  reads: 'name',
  run: (text, context: DetectorContext): readonly DraftFinding[] => {
    const described = describeConfusables(text) ?? describeMixedScript(text);
    if (described === undefined) return [];
    return [
      {
        detector: 'D-03',
        severity: 'high',
        tool: context.tool.name,
        message: described.message,
        evidence: buildEvidence({
          context,
          pointerSegments: ['name'],
          snippetText: described.snippetText,
        }),
        fix:
          'Compare this name against the tools already enabled in the ' +
          'workspace. If it is a near-copy of one of them, reject the server ' +
          'outright — there is no accidental version of this.',
      },
    ];
  },
};
