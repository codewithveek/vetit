import {
  buildShoutedBlockPattern,
  buildShoutedTagPattern,
} from './tag-syntax.js';

/**
 * The part of a description a human actually sees.
 *
 * This exists because of a hole found while testing D-07 against the decoy.
 * The rule was "a parameter is documented if the description mentions it" —
 * and the poisoned `add` tool passed, because the hidden `<IMPORTANT>` block
 * mentions `sidenote` while instructing the model to fill it with a private
 * key. The attacker's own payload was being read as documentation.
 *
 * So a mention only counts when it is in text a reviewer can read. Hidden
 * containers are removed entirely here — not labelled, as the redaction layer
 * does, because the question being asked is different: redaction asks "what is
 * safe to show?", and this asks "what did the reader actually see?"
 *
 * The tag patterns are shared with D-01. They were near-copies, and an
 * attribute was enough to slip past both at once: `<IMPORTANT role="note">`
 * was neither reported as an instruction block nor removed from here, so the
 * payload inside it counted as documentation for the parameter it named.
 *
 * Pure text in, pure text out. No detector state, no ordering assumptions.
 */

const HIDDEN_CONTAINERS: readonly RegExp[] = [
  /<!--[\s\S]*?(?:-->|$)/g,
  /<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g,
  /<\?[\s\S]*?(?:\?>|$)/g,
  /\[(?:\/\/|comment)\]:\s*(?:#|<>)[^\n]*/gi,
];

export function extractVisibleText(text: string): string {
  let visible = text;
  for (const container of HIDDEN_CONTAINERS) {
    visible = visible.replaceAll(container, ' ');
  }
  visible = visible.replaceAll(buildShoutedBlockPattern(), ' ');
  return visible.replaceAll(buildShoutedTagPattern(), ' ');
}
