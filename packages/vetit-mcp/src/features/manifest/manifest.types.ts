import type {
  ListingStatus,
  ManifestSource,
  StoredManifest,
} from './manifest.schema.js';

export type { ListingStatus, ManifestSource, StoredManifest };

/** How many pages each listing took, so "we read it all" is checkable. */
export interface PagesFetched {
  readonly tools: number;
  readonly resources: number;
  readonly prompts: number;
}

/**
 * What `fetch_manifest` returns to the agent, and nothing more.
 *
 * No descriptions, no parameter names, no server-supplied text of any kind —
 * with one deliberate exception: `duplicate_tool_names`, because a reviewer
 * cannot act on "two tools share a name" without knowing which name. It goes
 * through the redaction gate at the transport boundary like everything else.
 *
 * The raw manifest goes to a file and the detectors read it from there. That
 * is §4 Rule 1 applied to the very first tool in the pipeline.
 */
export interface ManifestSummary {
  readonly manifest_id: string;
  readonly path: string;
  readonly tool_count: number;
  /** Entries the target sent that are not usable as tools. Never hidden. */
  readonly unparseable_tool_count: number;
  readonly duplicate_tool_names: readonly string[];
  readonly resource_count: number;
  readonly prompt_count: number;
  /** `unsupported` means the server does not offer the operation at all. */
  readonly resources_status: ListingStatus;
  readonly prompts_status: ListingStatus;
  readonly pages_fetched: PagesFetched;
  readonly manifest_hash: string;
  readonly per_tool_hashes: Readonly<Record<string, string>>;
}
