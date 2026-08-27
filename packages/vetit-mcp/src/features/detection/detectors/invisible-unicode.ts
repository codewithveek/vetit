import type { DetectorContext, DetectorDefinition, DraftFinding } from '../finding.types.js';
import { buildEvidence, excerptAround } from './build-evidence.js';

/**
 * D-02 — characters that are in the text but not on the screen.
 *
 * Zero-width spaces break up the words a reviewer would search for. Direction
 * overrides reorder a line so the tail of a sentence is never rendered. The
 * Unicode tag block can carry a whole paragraph invisibly. None of it has a
 * legitimate place in a tool description.
 *
 */

/**
 * Format characters, control characters, and the Unicode tag block.
 *
 * The control characters were missing. A backspace, an escape or a carriage
 * return can rewrite what a terminal shows, and JSON strings carry them
 * escaped quite happily — so a description could manipulate the evidence a
 * reviewer reads and no detector would say a word about it.
 *
 * Newline and tab are subtracted back out, deliberately. They are invisible in
 * the ordinary sense and entirely normal in a description, and a detector that
 * fires on every multi-line description is a detector people switch off.
 *
 * Carriage return gets a narrower excuse. As part of a CRLF pair it is just a
 * line ending and firing on it would flag every tool of every server written
 * on Windows. On its own it is how a line gets overwritten, so a lone one is
 * still reported. The second alternative below is what draws that line, and it
 * is written as an alternative rather than as a pre-pass so that every match
 * index still points into the original text.
 */
const INVISIBLE_PATTERN =
  /[\p{Cf}\u{E0000}-\u{E007F}]|\r(?!\n)|(?![\n\t\r])\p{Cc}/gu;

const NAMES: ReadonlyMap<number, string> = new Map([
  [0x00_08, 'backspace'],
  [0x00_0d, 'carriage return'],
  [0x00_1b, 'escape'],
  [0x20_0b, 'zero-width space'],
  [0x20_0c, 'zero-width non-joiner'],
  [0x20_0d, 'zero-width joiner'],
  [0x20_2d, 'left-to-right override'],
  [0x20_2e, 'right-to-left override'],
  [0x20_66, 'left-to-right isolate'],
  [0x20_69, 'pop directional isolate'],
  [0xfe_ff, 'byte order mark'],
]);

function describeCharacter(codePoint: number): string {
  const known = NAMES.get(codePoint);
  const hex = `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
  return known === undefined ? hex : `${known} (${hex})`;
}

export const invisibleUnicodeDetector: DetectorDefinition = {
  id: 'D-02',
  name: 'invisibleUnicode',
  severity: 'critical',
  reads: 'description',
  run: (text, context: DetectorContext): readonly DraftFinding[] => {
    const matches = [...text.matchAll(INVISIBLE_PATTERN)];
    if (matches.length === 0) return [];
    const names = [
      ...new Set(
        matches.map((match) => describeCharacter(match[0].codePointAt(0) ?? 0)),
      ),
    ];
    const firstIndex = matches[0]?.index ?? 0;
    return [
      {
        detector: 'D-02',
        severity: 'critical',
        tool: context.tool.name,
        message:
          `Description contains ${String(matches.length)} invisible ` +
          `character(s) a reviewer cannot see: ${names.join(', ')}.`,
        evidence: buildEvidence({
          context,
          pointerSegments: ['description'],
          snippetText: excerptAround({ text, matchIndex: firstIndex }),
        }),
        fix:
          'Open the manifest file and read the description with the invisible ' +
          'characters made visible. There is no honest reason for one to be ' +
          'in a tool description. Treat the server as hostile until the ' +
          'publisher explains it.',
      },
    ];
  },
};
