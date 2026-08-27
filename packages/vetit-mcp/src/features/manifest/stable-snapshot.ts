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
 *  3. every key sorted at every level
 *  4. JSON.stringify, then SHA-256
 *
 * A per-tool hash is stored as well, so a comparison can name *which* tool
 * changed instead of only saying that something did.
 */

const WHITESPACE_RUN = /\s+/g;

/**
 * Reflow tolerance, applied to prose and to nothing else.
 *
 * This used to run over every string at every depth, including the ones
 * inside `inputSchema`. That made real contract changes invisible: an `enum`
 * value going from "a  b" to "a b" accepts different input and hashed
 * identically, and so did a changed `pattern`, `const` or `default`. A tool
 * name gaining a trailing space hashed identically too, which is worse — that
 * is a different tool.
 *
 * A description is the one field where a server reformatting its own prose is
 * not a change worth waking anyone for. Everything else is compared exactly.
 */
function normaliseProse(value: string): string {
  return value.replaceAll(WHITESPACE_RUN, ' ').trim();
}

/**
 * Sorts keys at every level and leaves every value exactly as it was found.
 */
function canonicaliseStructure(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicaliseStructure(entry));
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .map(([key, entryValue]): [string, unknown] => [
        key,
        canonicaliseStructure(entryValue),
      ])
      .sort(([left], [right]) => (left < right ? -1 : 1));
    return Object.fromEntries(entries);
  }
  return value;
}

/** The four fields a change to which is a change worth knowing about. */
export function canonicaliseTool(tool: ManifestTool): unknown {
  return {
    name: tool.name,
    description: normaliseProse(tool.description ?? ''),
    inputSchema: canonicaliseStructure(tool.inputSchema ?? {}),
    annotations: canonicaliseStructure(tool.annotations ?? {}),
  };
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

export interface PerToolHashes {
  /** Every name a server can send becomes a real own entry. See `defineEntry`. */
  readonly hashes: Record<string, string>;
  /** Names the target published more than once. Recorded, never dropped. */
  readonly duplicateNames: readonly string[];
}

interface HashEntry {
  readonly name: string;
  readonly hash: string;
}

/**
 * Assignment would not do here.
 *
 * `hashes[name] = hash` for the name `__proto__` runs the inherited setter and
 * changes the object's prototype instead of adding an entry, so the tool
 * disappeared from the map while still counting towards `tool_count`.
 * `defineProperty` creates an own data property whatever the name is, and
 * `JSON.stringify` serialises it like any other.
 */
function defineEntry(target: Record<string, string>, entry: HashEntry): void {
  Object.defineProperty(target, entry.name, {
    value: entry.hash,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * A hash per tool, keyed by name.
 *
 * Two things plain assignment into `{}` got wrong. A tool named `__proto__`
 * set the prototype instead of adding an entry, so it vanished from the map
 * while still counting towards `tool_count`. And a server publishing the same
 * name twice silently overwrote the first hash.
 *
 * Duplicates are reported rather than refused: a manifest Vetit declines to
 * read is a manifest Vetit cannot report a finding on, and a server publishing
 * two tools under one name is exactly what a reviewer needs telling about.
 */
export function computePerToolHashes(
  tools: readonly ManifestTool[],
): PerToolHashes {
  const hashes: Record<string, string> = {};
  const seen = new Set<string>();
  const duplicateNames: string[] = [];
  for (const tool of sortToolsByName(tools)) {
    if (seen.has(tool.name)) {
      if (!duplicateNames.includes(tool.name)) duplicateNames.push(tool.name);
      continue;
    }
    seen.add(tool.name);
    defineEntry(hashes, { name: tool.name, hash: computeToolHash(tool) });
  }
  return { hashes, duplicateNames };
}
