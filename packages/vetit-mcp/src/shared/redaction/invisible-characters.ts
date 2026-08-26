/**
 * Making the invisible visible.
 *
 * Zero-width characters, direction overrides and Unicode tag characters let an
 * attacker put text into a description that a human reviewer never sees. They
 * are not stripped — they are replaced with a named marker, so the finding
 * says exactly what was hidden and where.
 */

/** Names for the characters worth calling by name in a report. */
const CHARACTER_NAMES: ReadonlyMap<number, string> = new Map([
  [0x00_ad, 'SHY'],
  [0x06_1c, 'ALM'],
  [0x18_0e, 'MVS'],
  [0x20_0b, 'ZWSP'],
  [0x20_0c, 'ZWNJ'],
  [0x20_0d, 'ZWJ'],
  [0x20_0e, 'LRM'],
  [0x20_0f, 'RLM'],
  [0x20_2a, 'LRE'],
  [0x20_2b, 'RLE'],
  [0x20_2c, 'PDF'],
  [0x20_2d, 'LRO'],
  [0x20_2e, 'RLO'],
  [0x20_60, 'WJ'],
  [0x20_66, 'LRI'],
  [0x20_67, 'RLI'],
  [0x20_68, 'FSI'],
  [0x20_69, 'PDI'],
  [0xfe_ff, 'BOM'],
]);

/**
 * Format characters, control characters, and the Unicode tag block that was
 * used to smuggle whole sentences past reviewers.
 */
const INVISIBLE_PATTERN = /[\p{Cf}\p{Cc}\u{E0000}-\u{E007F}]/gu;

/** Characters this project uses to build its own markers. Escaped so untrusted
 * text cannot forge a boundary and pretend to be Vetit's own output. */
const BOUNDARY_PATTERN = /[\u27E6\u27E7\u27EA\u27EB]/gu;

function nameCharacter(codePoint: number): string {
  const known = CHARACTER_NAMES.get(codePoint);
  if (known !== undefined) return known;
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

export interface InvisibleReplacementResult {
  readonly text: string;
  readonly replacedCount: number;
}

/** Replaces every character Vetit's own markers are built from. */
export function escapeBoundaryCharacters(text: string): string {
  return text.replaceAll(BOUNDARY_PATTERN, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return `[[${nameCharacter(codePoint)}]]`;
  });
}

/**
 * Replaces invisible characters with named markers, and newlines with a
 * marker too, so a snippet can never break the line it is reported on.
 */
export function replaceInvisibleCharacters(
  text: string,
): InvisibleReplacementResult {
  let replacedCount = 0;
  const replaced = text.replaceAll(INVISIBLE_PATTERN, (character) => {
    replacedCount += 1;
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === '\n') return '\u27EANL\u27EB';
    if (character === '\r') return '\u27EACR\u27EB';
    if (character === '\t') return '\u27EATAB\u27EB';
    return `\u27EA${nameCharacter(codePoint)}\u27EB`;
  });
  return { text: replaced, replacedCount };
}
