/**
 * Neutralising the containers instructions hide in.
 *
 * An HTML comment, an XML processing instruction, a `<IMPORTANT>` block or a
 * markdown comment all do the same job: they carry text that a rendered view
 * drops and a model reads in full. Vetit does not delete them — deleting
 * destroys the evidence — it replaces the delimiters with visible labels, so
 * the text is still readable and can no longer close, open or impersonate a
 * block.
 */

interface DelimiterRule {
  readonly pattern: RegExp;
  readonly replacement: string;
}

const DELIMITER_RULES: readonly DelimiterRule[] = [
  { pattern: /<!--/g, replacement: '\u27EAHTML_COMMENT_OPEN\u27EB' },
  { pattern: /--!?>/g, replacement: '\u27EAHTML_COMMENT_CLOSE\u27EB' },
  { pattern: /<!\[CDATA\[/g, replacement: '\u27EACDATA_OPEN\u27EB' },
  { pattern: /\]\]>/g, replacement: '\u27EACDATA_CLOSE\u27EB' },
  { pattern: /<\?/g, replacement: '\u27EAPI_OPEN\u27EB' },
  { pattern: /\?>/g, replacement: '\u27EAPI_CLOSE\u27EB' },
  // Markdown's comment idiom: `[//]: # (text)` and `[comment]: <> (text)`.
  { pattern: /\[(?:\/\/|comment)\]:\s*(?:#|<>)/gi, replacement: '\u27EAMD_COMMENT\u27EB' },
];

/** `<TAG>` and `</TAG>`, captured so the tag name survives into the report. */
const TAG_PATTERN = /<(\/?)([A-Za-z][\w.:-]*)\s*\/?>/g;

/** Anything angle-bracketed that the rules above did not already name. */
const RESIDUAL_ANGLE_PATTERN = /[<>]/g;

export interface HiddenBlockResult {
  readonly text: string;
  readonly neutralisedCount: number;
}

function applyDelimiterRules(text: string): HiddenBlockResult {
  let neutralisedCount = 0;
  let working = text;
  for (const rule of DELIMITER_RULES) {
    working = working.replaceAll(rule.pattern, () => {
      neutralisedCount += 1;
      return rule.replacement;
    });
  }
  return { text: working, neutralisedCount };
}

function labelTag(match: string): string {
  const parts = TAG_PATTERN.exec(match);
  TAG_PATTERN.lastIndex = 0;
  const isClosing = parts?.[1] === '/';
  const name = parts?.[2] ?? 'UNKNOWN';
  const label = isClosing ? 'TAG_END' : 'TAG';
  return `\u27EA${label}:${name.toUpperCase()}\u27EB`;
}

function applyTagRules(text: string): HiddenBlockResult {
  let neutralisedCount = 0;
  const working = text.replaceAll(TAG_PATTERN, (match) => {
    neutralisedCount += 1;
    return labelTag(match);
  });
  return { text: working, neutralisedCount };
}

/**
 * Runs every rule, then escapes any angle bracket left over. The backstop
 * matters: a rule that misses is a rule an attacker can walk through, and
 * there is no legitimate reason for a bare `<` to survive into a snippet.
 */
export function neutraliseHiddenBlocks(text: string): HiddenBlockResult {
  const delimiters = applyDelimiterRules(text);
  const tags = applyTagRules(delimiters.text);
  let residualCount = 0;
  const escaped = tags.text.replaceAll(RESIDUAL_ANGLE_PATTERN, (bracket) => {
    residualCount += 1;
    return bracket === '<' ? '\u27EALT\u27EB' : '\u27EAGT\u27EB';
  });
  return {
    text: escaped,
    neutralisedCount: delimiters.neutralisedCount + tags.neutralisedCount + residualCount,
  };
}
