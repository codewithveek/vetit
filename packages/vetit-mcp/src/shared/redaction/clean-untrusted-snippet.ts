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

const SNIPPET_OPEN = '⟦UNTRUSTED_TEXT: ';
const SNIPPET_CLOSE = ' ⟧';
const TRUNCATION_MARK = '⟪TRUNCATED⟫';
const CEILING_MARK = '⟪CEILING_REACHED⟫';

const MARKER_OPEN = '⟪';
const MARKER_CLOSE = '⟫';

export interface CleanSnippetOptions {
  readonly text: string;
  /**
   * A request for a *tighter* bound than §4's 120 characters, for reports with
   * no room. It cannot loosen one — see `resolveBudget`.
   */
  readonly characterBudget?: number;
}

/**
 * The budget a caller actually gets.
 *
 * `SNIPPET_CHARACTER_BUDGET` is a security bound, not a default, so this
 * function's only job is to make sure nothing can raise it. Before, the
 * option was used as given: `Infinity` disabled truncation entirely, `NaN`
 * made every comparison false so the whole text came through with
 * `wasTruncated` reading false, and any number above 120 simply returned more
 * untrusted content than §4 permits.
 *
 * Anything that is not a whole number of characters falls back to the
 * mandatory bound rather than throwing. This runs on the return path of every
 * tool, and turning a caller's bad argument into an exception there would
 * trade a slightly-too-long snippet for a tool that fails at the exact moment
 * it is holding hostile text.
 */
function resolveBudget(requested: number | undefined): number {
  if (requested === undefined) return SNIPPET_CHARACTER_BUDGET;
  if (!Number.isInteger(requested) || requested < 0) {
    return SNIPPET_CHARACTER_BUDGET;
  }
  return Math.min(requested, SNIPPET_CHARACTER_BUDGET);
}

/**
 * Cuts to a length without slicing through a marker this module generated.
 *
 * A cut landing inside `⟪ZWSP⟫` would leave a dangling `⟪ZWS` — an opener with
 * no closer, in a snippet whose whole purpose is that its markers are
 * trustworthy. Backing up to the unmatched opener costs a few characters and
 * keeps every marker in the output whole.
 */
function cutWithoutSplittingMarker(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, Math.max(0, limit));
  const lastOpen = cut.lastIndexOf(MARKER_OPEN);
  const lastClose = cut.lastIndexOf(MARKER_CLOSE);
  return lastOpen > lastClose ? cut.slice(0, lastOpen) : cut;
}

interface BodyOptions {
  readonly cleanedText: string;
  readonly wasTruncated: boolean;
}

/**
 * Builds the body so that the wrapper, the truncation mark and the ceiling
 * mark all fit inside `RENDERED_CHARACTER_CEILING`.
 *
 * The ceiling is documented as bounding what actually gets returned, so the
 * space every required marker needs is reserved before the cut rather than
 * appended after it.
 */
function buildBody(options: BodyOptions): string {
  const suffix = options.wasTruncated ? TRUNCATION_MARK : '';
  const roomForBody =
    RENDERED_CHARACTER_CEILING -
    SNIPPET_OPEN.length -
    SNIPPET_CLOSE.length -
    suffix.length;
  if (options.cleanedText.length <= roomForBody) {
    return options.cleanedText + suffix;
  }
  const cut = cutWithoutSplittingMarker(
    options.cleanedText,
    roomForBody - CEILING_MARK.length,
  );
  return cut + CEILING_MARK + suffix;
}

export function cleanUntrustedSnippet(options: CleanSnippetOptions): CleanedSnippet {
  const budget = resolveBudget(options.characterBudget);
  const originalLength = options.text.length;
  const wasTruncated = originalLength > budget;
  const truncated = wasTruncated ? options.text.slice(0, budget) : options.text;

  const escaped = escapeBoundaryCharacters(truncated);
  const withoutBlocks = neutraliseHiddenBlocks(escaped);
  const visible = replaceInvisibleCharacters(withoutBlocks.text);

  const body = buildBody({ cleanedText: visible.text, wasTruncated });
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
