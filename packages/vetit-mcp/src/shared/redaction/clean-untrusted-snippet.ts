import { neutraliseHiddenBlocks } from './hidden-blocks.js';
import {
  escapeBoundaryCharacters,
  replaceInvisibleCharacters,
} from './invisible-characters.js';
import type { CleanedSnippet } from './redaction.types.js';
import {
  RENDERED_CHARACTER_CEILING,
  SNIPPET_CHARACTER_BUDGET,
} from './redaction.types.js';

/**
 * Spec §4 Rule 1, in one function.
 *
 * Nothing a target server said may reach the reviewing agent unless it has
 * been through here. Order matters:
 *
 *  1. measure and truncate, so the untrusted budget is fixed before anything
 *     expands it
 *  2. escape the characters Vetit builds its own markers from, so untrusted
 *     text cannot forge a boundary
 *  3. neutralise comment, tag and markdown-comment delimiters
 *  4. make invisible characters and newlines visible
 *  5. cap the rendered result and wrap it
 *
 * Steps 2 and 3 must run in that order. Reversing them would let the tag rules
 * emit text that looks like a Vetit marker, leaving it indistinguishable from
 * one Vetit wrote itself.
 */

const SNIPPET_OPEN = '\u27E6UNTRUSTED_TEXT: ';
const SNIPPET_CLOSE = ' \u27E7';
const TRUNCATION_MARK = '\u27EATRUNCATED\u27EB';
const CEILING_MARK = '\u27EACEILING_REACHED\u27EB';

export interface CleanSnippetOptions {
  readonly text: string;
  /** Defaults to the §4 budget. Lower it for tight report layouts. */
  readonly characterBudget?: number;
}

function applyCeiling(text: string): string {
  if (text.length <= RENDERED_CHARACTER_CEILING) return text;
  return text.slice(0, RENDERED_CHARACTER_CEILING) + CEILING_MARK;
}

export function cleanUntrustedSnippet(options: CleanSnippetOptions): CleanedSnippet {
  const budget = options.characterBudget ?? SNIPPET_CHARACTER_BUDGET;
  const originalLength = options.text.length;
  const wasTruncated = originalLength > budget;
  const truncated = wasTruncated ? options.text.slice(0, budget) : options.text;

  const escaped = escapeBoundaryCharacters(truncated);
  const withoutBlocks = neutraliseHiddenBlocks(escaped);
  const visible = replaceInvisibleCharacters(withoutBlocks.text);

  const body = applyCeiling(visible.text) + (wasTruncated ? TRUNCATION_MARK : '');
  return {
    renderedText: SNIPPET_OPEN + body + SNIPPET_CLOSE,
    originalLength,
    wasTruncated,
    invisibleCharacterCount: visible.replacedCount,
    hiddenBlockMarkerCount: withoutBlocks.neutralisedCount,
  };
}

/**
 * The version to reach for when there is nothing to show.
 *
 * §4 Rule 1 ends with "never return a snippet that has skipped this cleaning,
 * even when the answer is nothing found". An empty string still gets wrapped,
 * so every snippet in every report has the same, recognisable shape.
 */
export function cleanEmptySnippet(): CleanedSnippet {
  return cleanUntrustedSnippet({ text: '' });
}
