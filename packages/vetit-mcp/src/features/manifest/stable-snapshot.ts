import { createHash } from 'node:crypto';
import type { ManifestTool } from './manifest.schema.js';

/**
 * Hashing what matters, and nothing else.
 *
 * Hash the raw response and you get a false alarm every time a server bumps a
 * version or reorders a key, and people stop reading the alerts. So the
 * manifest is stripped down first, always the same way (spec §9):
 *
 *  1. tools only, sorted by name
 *  2. per tool keep name, description, inputSchema, annotations
 *  3. every key sorted at every level; runs of whitespace collapsed; ends
 *     trimmed
 *  4. JSON.stringify, then SHA-256
 *
 * A per-tool hash is stored as well, so a comparison can name *which* tool
 * changed instead of only saying that something did.
 */

const WHITESPACE_RUN = /\s+/g;

function normaliseText(value: string): string {
  return value.replaceAll(WHITESPACE_RUN, ' ').trim();
}

/** Sorts keys at every level and normalises every string it passes. */
function canonicaliseValue(value: unknown): unknown {
  if (typeof value === 'string') return normaliseText(value);
  if (Array.isArray(value)) return value.map((entry) => canonicaliseValue(entry));
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .map(([key, entryValue]): [string, unknown] => [key, canonicaliseValue(entryValue)])
      .sort(([left], [right]) => (left < right ? -1 : 1));
    return Object.fromEntries(entries);
  }
  return value;
}

/** The four fields a change to which is a change worth knowing about. */
export function canonicaliseTool(tool: ManifestTool): unknown {
  return canonicaliseValue({
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? {},
    annotations: tool.annotations ?? {},
  });
}

function sha256(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function computeToolHash(tool: ManifestTool): string {
  return sha256(JSON.stringify(canonicaliseTool(tool)));
}

export function sortToolsByName(tools: readonly ManifestTool[]): ManifestTool[] {
  return [...tools].sort((left, right) => (left.name < right.name ? -1 : 1));
}

export function computeManifestHash(tools: readonly ManifestTool[]): string {
  const canonical = sortToolsByName(tools).map((tool) => canonicaliseTool(tool));
  return sha256(JSON.stringify(canonical));
}

export function computePerToolHashes(
  tools: readonly ManifestTool[],
): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const tool of sortToolsByName(tools)) {
    hashes[tool.name] = computeToolHash(tool);
  }
  return hashes;
}
