/**
 * One definition of what a tag looks like.
 *
 * D-01 and the visible-text helper both have to agree about this, and they did
 * not: an attribute was enough to slip past both. `<IMPORTANT role="note">`
 * was not recognised as an instruction block, *and* the block was not removed
 * from the visible text — so the payload inside it counted as documentation
 * and exonerated the exfiltration parameter it named. Two near-copies of a
 * pattern is how that happens, so there is now one copy.
 *
 * None of this parses or trusts markup. It recognises the shape well enough to
 * say "something is hiding in here", which is all a detector needs.
 */

/** Attributes, if any: a space and then anything up to the closing bracket. */
const ATTRIBUTES = String.raw`(?:\s[^<>]*)?`;

/** `<name ...>` or `</name>`, with or without a self-closing slash. */
export function buildTagPattern(): RegExp {
  return new RegExp(String.raw`<(/?)([A-Za-z][\w.:-]*)${ATTRIBUTES}/?>`, 'g');
}

/**
 * A shouted block and everything inside it: `<IMPORTANT ...> … </IMPORTANT>`.
 *
 * Unterminated blocks match to the end of the text on purpose. An opener with
 * no closer still hides everything after it.
 */
export function buildShoutedBlockPattern(): RegExp {
  return new RegExp(
    String.raw`<([A-Z][A-Z0-9_]{2,})${ATTRIBUTES}>[\s\S]*?(?:</\1\s*>|$)`,
    'g',
  );
}

/** A lone shouted tag with no partner. */
export function buildShoutedTagPattern(): RegExp {
  return new RegExp(String.raw`</?[A-Z][A-Z0-9_]{2,}${ATTRIBUTES}/?>`, 'g');
}
