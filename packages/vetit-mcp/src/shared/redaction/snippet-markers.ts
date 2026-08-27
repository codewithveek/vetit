/**
 * The characters and labels Vetit builds its own output from.
 *
 * One definition, shared by the cleaner that emits them and the guard that
 * recognises them. The guard previously carried its own copy of the prefix,
 * which is how it came to trust a string for merely starting with one.
 */

export const SNIPPET_OPEN = '⟦UNTRUSTED_TEXT: ';
export const SNIPPET_CLOSE = ' ⟧';

export const MARKER_OPEN = '⟪';
export const MARKER_CLOSE = '⟫';

export const TRUNCATION_MARK = '⟪TRUNCATED⟫';
export const CEILING_MARK = '⟪CEILING_REACHED⟫';

/**
 * What the cleaner guarantees about the inside of a wrapped snippet: no angle
 * brackets, no outer wrapper characters, and nothing invisible.
 *
 * Written here rather than in the guard so the promise and the check on that
 * promise cannot drift apart.
 */
export const UNSAFE_INSIDE_SNIPPET =
  /[<>⟦⟧]|[\p{Cf}\p{Cc}\u{E0000}-\u{E007F}]/u;

/** Every marker the cleaner emits looks like this, and nothing else does. */
export const WELL_FORMED_MARKER = /^[A-Z0-9_+:.]+$/;
