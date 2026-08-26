import type { ManifestSource, StoredManifest } from './manifest.schema.js';

export type { ManifestSource, StoredManifest };

/**
 * What `fetch_manifest` returns to the agent, and nothing more.
 *
 * No descriptions, no parameter names, no server-supplied text of any kind:
 * counts, hashes and a path on disk. Spec §4 Rule 1 — the raw manifest goes to
 * a file, and the agent reads it through the detectors, never directly.
 */
export interface ManifestSummary {
  readonly manifest_id: string;
  readonly path: string;
  readonly tool_count: number;
  readonly resource_count: number;
  readonly prompt_count: number;
  readonly manifest_hash: string;
  readonly per_tool_hashes: Readonly<Record<string, string>>;
}
