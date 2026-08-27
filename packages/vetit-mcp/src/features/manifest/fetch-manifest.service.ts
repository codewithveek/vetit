import { ulid } from 'ulid';
import { listTargetSurface } from '../../shared/mcp-client/index.js';
import { listConnectorTools } from '../../shared/trueforge-client/index.js';
import {
  manifestToolSchema,
  namedEntrySchema,
  serverInfoSchema,
  type ListingStatus,
  type ManifestSource,
  type ManifestTool,
  type RawListing,
  type StoredManifest,
} from './manifest.schema.js';
import type { ManifestSummary } from './manifest.types.js';
import { writeStoredManifest } from './manifest-store.service.js';
import { computeManifestHash, computePerToolHashes } from './stable-snapshot.js';

/**
 * Listing what a server offers, two ways.
 *
 * Directly, when the server needs no credential — plenty do not, because
 * saying what you can do is not a privileged act. Or through a TrueForge
 * connector, in which case the harness resolves the key on its own server and
 * hands back the tool list. Vetit never sees the credential either way
 * (spec §6).
 */

function extractNames(entries: readonly unknown[]): string[] {
  return entries
    .map((entry) => namedEntrySchema.safeParse(entry))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data.name);
}

interface ValidatedTools {
  readonly tools: ManifestTool[];
  readonly unparseableToolCount: number;
}

/**
 * Validates each tool on its own.
 *
 * Parsing the array as a whole meant one malformed entry threw away every
 * other tool in the manifest — and a server that wants to avoid review has
 * every reason to send one. Bad entries are counted, and they are still in
 * `raw` where a human can look at them.
 */
function validateTools(rawTools: readonly unknown[]): ValidatedTools {
  const tools: ManifestTool[] = [];
  let unparseableToolCount = 0;
  for (const entry of rawTools) {
    const parsed = manifestToolSchema.safeParse(entry);
    if (parsed.success) tools.push(parsed.data);
    else unparseableToolCount += 1;
  }
  return { tools, unparseableToolCount };
}

interface ListedSurface {
  readonly raw: RawListing;
  readonly resourcesStatus: ListingStatus;
  readonly promptsStatus: ListingStatus;
  readonly serverName: string | undefined;
  readonly serverVersion: string | undefined;
}

async function listDirectly(url: string): Promise<ListedSurface> {
  const listing = await listTargetSurface({ url });
  const serverInfo = serverInfoSchema.safeParse(listing.serverInfo);
  return {
    raw: {
      serverInfo: listing.serverInfo,
      capabilities: listing.capabilities,
      tools: [...listing.tools],
      ...(listing.resources === undefined
        ? {}
        : { resources: [...listing.resources] }),
      ...(listing.prompts === undefined ? {} : { prompts: [...listing.prompts] }),
      pageCounts: listing.pageCounts,
    },
    resourcesStatus: listing.resources === undefined ? 'unsupported' : 'listed',
    promptsStatus: listing.prompts === undefined ? 'unsupported' : 'listed',
    serverName: serverInfo.success ? serverInfo.data.name : undefined,
    serverVersion: serverInfo.success ? serverInfo.data.version : undefined,
  };
}

/**
 * The connector path lists tools only — the admin API exposes no resource or
 * prompt listing — so both are recorded as unsupported rather than as empty.
 */
async function listThroughConnector(connectorName: string): Promise<ListedSurface> {
  const tools = await listConnectorTools(connectorName);
  return {
    raw: {
      tools: [...tools],
      pageCounts: { tools: 1, resources: 0, prompts: 0 },
    },
    resourcesStatus: 'unsupported',
    promptsStatus: 'unsupported',
    serverName: connectorName,
    serverVersion: undefined,
  };
}

export interface FetchManifestOptions {
  readonly url: string | undefined;
  readonly connectorName: string | undefined;
}

export class ManifestSourceError extends Error {
  constructor() {
    super('fetch_manifest needs either a url or a connector_name.');
    this.name = 'ManifestSourceError';
  }
}

function buildSource(options: FetchManifestOptions): ManifestSource {
  if (options.connectorName !== undefined) {
    return { kind: 'connector', connectorName: options.connectorName };
  }
  if (options.url !== undefined) return { kind: 'direct', url: options.url };
  throw new ManifestSourceError();
}

async function listSurface(source: ManifestSource): Promise<ListedSurface> {
  return source.kind === 'connector'
    ? await listThroughConnector(source.connectorName)
    : await listDirectly(source.url);
}

interface StoredManifestInput {
  readonly source: ManifestSource;
  readonly surface: ListedSurface;
}

function buildStoredManifest(input: StoredManifestInput): StoredManifest {
  const { source, surface } = input;
  const { tools, unparseableToolCount } = validateTools(surface.raw.tools);
  const perTool = computePerToolHashes(tools);
  return {
    manifestId: ulid(),
    fetchedAt: new Date().toISOString(),
    source,
    ...(surface.serverName === undefined ? {} : { serverName: surface.serverName }),
    ...(surface.serverVersion === undefined
      ? {}
      : { serverVersion: surface.serverVersion }),
    tools,
    unparseableToolCount,
    resourceNames: extractNames(surface.raw.resources ?? []),
    promptNames: extractNames(surface.raw.prompts ?? []),
    resourcesStatus: surface.resourcesStatus,
    promptsStatus: surface.promptsStatus,
    manifestHash: computeManifestHash(tools),
    perToolHashes: perTool.hashes,
    duplicateToolNames: [...perTool.duplicateNames],
    raw: surface.raw,
  };
}

interface SummaryInput {
  readonly manifest: StoredManifest;
  readonly path: string;
}

function summarise(input: SummaryInput): ManifestSummary {
  const { manifest, path } = input;
  return {
    manifest_id: manifest.manifestId,
    path,
    tool_count: manifest.tools.length,
    unparseable_tool_count: manifest.unparseableToolCount,
    duplicate_tool_names: manifest.duplicateToolNames,
    resource_count: manifest.resourceNames.length,
    prompt_count: manifest.promptNames.length,
    resources_status: manifest.resourcesStatus,
    prompts_status: manifest.promptsStatus,
    pages_fetched: manifest.raw.pageCounts,
    manifest_hash: manifest.manifestHash,
    per_tool_hashes: manifest.perToolHashes,
  };
}

/**
 * The whole of `fetch_manifest`: list, write the raw result to disk, and hand
 * back counts and hashes. Not one character the target wrote comes back.
 */
export async function fetchManifest(
  options: FetchManifestOptions,
): Promise<ManifestSummary> {
  const source = buildSource(options);
  const surface = await listSurface(source);
  const manifest = buildStoredManifest({ source, surface });
  const path = await writeStoredManifest(manifest);
  return summarise({ manifest, path });
}
