import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { neutraliseHiddenBlocks } from './hidden-blocks.js';
import {
  escapeBoundaryCharacters,
  replaceInvisibleCharacters,
} from './invisible-characters.js';

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
 *
 * Strings already wrapped by `cleanUntrustedSnippet` are left exactly as they
 * are. Cleaning them twice would double-escape the markers and make the
 * evidence harder to read for no gain in safety.
 */

const SNIPPET_PREFIX = '⟦UNTRUSTED_TEXT: ';

function guardString(value: string): string {
  if (value.startsWith(SNIPPET_PREFIX)) return value;
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
