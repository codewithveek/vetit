import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { neutraliseHiddenBlocks } from './hidden-blocks.js';
import {
  escapeBoundaryCharacters,
  replaceInvisibleCharacters,
} from './invisible-characters.js';
import { RENDERED_CHARACTER_CEILING } from './redaction.types.js';
import {
  MARKER_CLOSE,
  MARKER_OPEN,
  SNIPPET_CLOSE,
  SNIPPET_OPEN,
  UNSAFE_INSIDE_SNIPPET,
  WELL_FORMED_MARKER,
} from './snippet-markers.js';

/**
 * The last gate before anything leaves a Vetit tool.
 *
 * Spec §15: "Everything an MCP tool returns goes through shared/redaction
 * first. No exceptions, ever." This is that gate, and it is deliberately
 * placed at the transport boundary rather than left to each tool to remember.
 *
 * It matters even though every tool returns a structured object Vetit built
 * itself, because parts of those objects came from the target: tool names,
 * host names, the tag name interpolated into a D-01 message. A tool name
 * carrying a zero-width character would otherwise reach the agent intact.
 */

/**
 * Whether a string can be passed through untouched.
 *
 * The rule used to be "it starts with the snippet prefix", and a prefix is
 * something a target can type. A tool named `⟦UNTRUSTED_TEXT: <IMPORTANT>…`
 * was waved through with every delimiter and invisible character intact —
 * the one path in the codebase that returns unredacted text to the agent,
 * reachable by choosing a name.
 *
 * The prefix is no longer evidence of anything. What is checked instead is
 * whether the string actually holds the properties a cleaned snippet is
 * defined by: wrapped at both ends, inside the length ceiling, no angle
 * brackets, no wrapper characters, nothing invisible, and no marker that the
 * cleaner would not itself have written.
 *
 * That check is sound in a way trusting the prefix never was. If a forged
 * string satisfies every one of those properties, then it is clean — because
 * those properties *are* what clean means. There is nothing left to forge.
 */
function isWellFormedCleanSnippet(value: string): boolean {
  if (!value.startsWith(SNIPPET_OPEN) || !value.endsWith(SNIPPET_CLOSE)) return false;
  if (value.length > RENDERED_CHARACTER_CEILING) return false;
  const body = value.slice(SNIPPET_OPEN.length, -SNIPPET_CLOSE.length);
  if (UNSAFE_INSIDE_SNIPPET.test(body)) return false;
  return hasOnlyWellFormedMarkers(body);
}

/**
 * Markers must be balanced and named the way the cleaner names them.
 *
 * Not a safety property on its own — a stray `⟪` cannot instruct anybody — but
 * a forged `⟪TRUNCATED⟫` would tell a reviewer the evidence was cut when it
 * was not, and misleading evidence in a security report is its own harm.
 */
function hasOnlyWellFormedMarkers(body: string): boolean {
  const segments = body.split(MARKER_OPEN);
  const leading = segments.shift() ?? '';
  if (leading.includes(MARKER_CLOSE)) return false;
  return segments.every((segment) => {
    const end = segment.indexOf(MARKER_CLOSE);
    if (end === -1) return false;
    const label = segment.slice(0, end);
    const rest = segment.slice(end + MARKER_CLOSE.length);
    return WELL_FORMED_MARKER.test(label) && !rest.includes(MARKER_CLOSE);
  });
}

function guardString(value: string): string {
  if (isWellFormedCleanSnippet(value)) return value;
  const escaped = escapeBoundaryCharacters(value);
  const withoutBlocks = neutraliseHiddenBlocks(escaped);
  return replaceInvisibleCharacters(withoutBlocks.text).text;
}

/**
 * Walks the payload and guards every string in it, at any depth, including
 * object keys — a tool name becomes a key in the per-tool hash map.
 */
export function guardToolPayload(value: unknown): unknown {
  if (typeof value === 'string') return guardString(value);
  if (Array.isArray(value)) return value.map((entry) => guardToolPayload(entry));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]): [string, unknown] => [
        guardString(key),
        guardToolPayload(entry),
      ]),
    );
  }
  return value;
}

/**
 * The shape every Vetit tool returns.
 *
 * JSON, guarded, and nothing else. A tool that returned prose would be handing
 * the agent something to read as an instruction; a tool that returns a
 * structured record hands it something to act on.
 */
export function buildGuardedToolResult(payload: unknown): CallToolResult {
  return {
    content: [
      { type: 'text', text: JSON.stringify(guardToolPayload(payload), undefined, 2) },
    ],
  };
}
