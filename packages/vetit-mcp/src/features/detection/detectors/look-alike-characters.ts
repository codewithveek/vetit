import type { DetectorContext, DetectorDefinition, DraftFinding } from '../finding.types.js';
import { buildEvidence } from './build-evidence.js';

/**
 * D-03 — a tool name that reads as one thing and is another.
 *
 * `sendmеssage` with a Cyrillic `е` is a different string from `sendmessage`,
 * and no amount of careful reading will tell them apart. Used to impersonate a
 * tool a workspace already trusts.
 *
 * Three signals, any of which fires:
 *
 *  - a name that mixes ASCII letters with letters from another script, which
 *    is the shape the attack takes
 *  - a confusable character *in that mixed context*, which names the trick
 *    precisely
 *  - a name whose look-alike skeleton matches a tool already enabled here,
 *    which is impersonation proven rather than suspected, and which is the one
 *    case worth firing on even when the name is entirely non-ASCII
 *
 * A name written wholly in another script and resembling nothing is not
 * flagged. It is unusual, it impersonates nothing, and calling it an attack is
 * how a detector gets switched off.
 */

/** Characters that render as an ASCII letter but are not one. */
const CONFUSABLES: ReadonlyMap<string, string> = new Map([
  ['а', 'a'], ['е', 'e'], ['о', 'o'], ['р', 'p'],
  ['с', 'c'], ['у', 'y'], ['х', 'x'], ['і', 'i'],
  ['ѕ', 's'], ['ј', 'j'], ['һ', 'h'], ['ԁ', 'd'],
  ['ο', 'o'], ['α', 'a'], ['ν', 'v'], ['ρ', 'p'],
  ['υ', 'u'], ['ɡ', 'g'], ['ᴏ', 'o'], ['ａ', 'a'],
]);

const ASCII_LETTER = /[A-Za-z]/;

/**
 * Letters from another script — not merely anything non-ASCII.
 *
 * This used to be `\P{ASCII}`, which matches emoji, punctuation, combining
 * marks and symbols. A tool honestly named `search_🔍` was reported as a
 * mixed-script impersonation attempt at high severity, which is nonsense: an
 * emoji resembles no ASCII letter and impersonates nothing.
 */
const NON_ASCII_LETTER = /(?![\p{ASCII}])\p{L}/u;

/** What the name would read as if every look-alike were the letter it apes. */
function toSkeleton(name: string): string {
  return Array.from(name)
    .map((character) => CONFUSABLES.get(character) ?? character)
    .join('')
    .toLowerCase();
}

interface NameFinding {
  readonly message: string;
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
  };
}

function describeMixedScript(name: string): NameFinding | undefined {
  if (!ASCII_LETTER.test(name) || !NON_ASCII_LETTER.test(name)) return undefined;
  return {
    message:
      'Tool name mixes ASCII letters with letters from another script, which ' +
      'is how a name is made to read like one a workspace already trusts.',
  };
}

/**
 * The strongest signal, and the only one that survives a wholly non-ASCII name.
 *
 * A name written entirely in Cyrillic homoglyphs impersonates nothing on its
 * own — but if flattening its look-alikes produces the name of a tool already
 * enabled here, it is impersonating that tool, and the mixed-script rule would
 * never have caught it.
 */
function describeSkeletonCollision(
  name: string,
  installedToolNames: readonly string[],
): NameFinding | undefined {
  const skeleton = toSkeleton(name);
  if (skeleton === name.toLowerCase()) return undefined;
  const impersonated = installedToolNames.find(
    (installed) => installed.toLowerCase() === skeleton,
  );
  if (impersonated === undefined) return undefined;
  return {
    message:
      `Tool name is a look-alike of "${impersonated}", a tool already enabled ` +
      'in this workspace. Flattening its look-alike characters produces that ' +
      'name exactly.',
  };
}

function describeName(
  name: string,
  context: DetectorContext,
): NameFinding | undefined {
  const collision = describeSkeletonCollision(name, context.installedToolNames);
  if (collision !== undefined) return collision;
  // Both remaining signals need an ASCII letter to be impersonating anything.
  if (!ASCII_LETTER.test(name)) return undefined;
  return describeConfusables(name) ?? describeMixedScript(name);
}

export const lookAlikeCharactersDetector: DetectorDefinition = {
  id: 'D-03',
  name: 'lookAlikeCharacters',
  severity: 'high',
  reads: 'name',
  run: (text, context: DetectorContext): readonly DraftFinding[] => {
    const described = describeName(text, context);
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
          snippetText: text,
        }),
        fix:
          'Compare this name against the tools already enabled in the ' +
          'workspace. If it is a near-copy of one of them, reject the server ' +
          'outright — there is no accidental version of this.',
      },
    ];
  },
};
