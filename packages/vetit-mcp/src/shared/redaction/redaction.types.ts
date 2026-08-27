/**
 * The result of cleaning one piece of untrusted text.
 *
 * `renderedText` is the only field that may ever be shown to a model. The
 * counts exist so a finding can say *how much* was neutralised without
 * reproducing any of it.
 */
export interface CleanedSnippet {
  /** Ready to return: neutralised, one line, and wrapped in boundary markers. */
  readonly renderedText: string;
  /** Length of the text as it arrived, before any truncation or cleaning. */
  readonly originalLength: number;
  /** True when the source text was longer than the snippet budget. */
  readonly wasTruncated: boolean;
  /** How many invisible characters were made visible. */
  readonly invisibleCharacterCount: number;
  /** How many comment, tag or markdown-comment delimiters were neutralised. */
  readonly hiddenBlockMarkerCount: number;
}

/** How much untrusted text a snippet may carry. Spec §4 Rule 1. */
export const SNIPPET_CHARACTER_BUDGET = 120;

/**
 * The absolute maximum length of `renderedText` — wrapper, truncation mark and
 * ceiling mark included.
 *
 * Neutralising expands the text (120 zero-width characters become 120 visible
 * markers), so the budget above bounds the untrusted *input* and this bounds
 * the whole *output*. The space every required marker needs is reserved before
 * the body is cut, rather than appended afterwards, so `renderedText.length`
 * is never greater than this number. There is a test asserting exactly that.
 */
export const RENDERED_CHARACTER_CEILING = 600;
