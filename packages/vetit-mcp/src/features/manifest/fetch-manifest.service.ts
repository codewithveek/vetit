import { ulid } from 'ulid';
import { listTargetSurface } from '../../shared/mcp-client/index.js';
import { listConnectorTools } from '../../shared/trueforge-client/index.js';
import {
  manifestToolSchema,
  namedEntrySchema,
  targetListingSchema,
  type ManifestSource,
  type ManifestTool,
  type StoredManifest,
} from './manifest.schema.js';
import type { ManifestSummary } from './manifest.types.js';
import { writeStoredManifest } from './manifest-store.service.js';
import { computeManifestHash, computePerToolHashes } from './stable-snapshot.js';
import { z } from 'zod';

/**
 * Listing what a server offers, two ways.
 *
 * Directly, when the server needs no credential — plenty do not, because
 * saying what you can do is not a privileged act. Or through a TrueForge
 * connector, in which case the harness resolves the key on its own server and
 * hands back the tool list. Vetit never sees the credential either way
 * (spec §6).
 */

const namesSchema = z.array(namedEntrySchema);

function extractNames(entries: unknown): string[] {
  const parsed = namesSchema.safeParse(entries);
  return parsed.success ? parsed.data.map((entry) => entry.name) : [];
}

interface ListedSurface {
  readonly tools: readonly ManifestTool[];
  readonly resourceNames: readonly string[];
  readonly promptNames: readonly string[];
  readonly serverName: string | undefined;
  readonly serverVersion: string | undefined;
}

async function listDirectly(url: string): Promise<ListedSurface> {
  const raw = await listTargetSurface({ url });
  const listing = targetListingSchema.parse(raw);
  return {
    tools: listing.tools.tools,
    resourceNames: extractNames(listing.resources?.resources),
    promptNames: extractNames(listing.prompts?.prompts),
    serverName: listing.serverInfo?.name,
    serverVersion: listing.serverInfo?.version,
  };
}

async function listThroughConnector(connectorName: string): Promise<ListedSurface> {
  const tools = await listConnectorTools(connectorName);
  return {
    tools: z.array(manifestToolSchema).parse(tools),
    resourceNames: [],
    promptNames: [],
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

function buildStoredManifest(
  source: ManifestSource,
  surface: ListedSurface,
): StoredManifest {
  return {
    manifestId: ulid(),
    fetchedAt: new Date().toISOString(),
    source,
    ...(surface.serverName === undefined ? {} : { serverName: surface.serverName }),
    ...(surface.serverVersion === undefined
      ? {}
      : { serverVersion: surface.serverVersion }),
    tools: [...surface.tools],
    resourceNames: [...surface.resourceNames],
    promptNames: [...surface.promptNames],
    manifestHash: computeManifestHash(surface.tools),
    perToolHashes: computePerToolHashes(surface.tools),
  };
}

function summarise(manifest: StoredManifest, path: string): ManifestSummary {
  return {
    manifest_id: manifest.manifestId,
    path,
    tool_count: manifest.tools.length,
    resource_count: manifest.resourceNames.length,
    prompt_count: manifest.promptNames.length,
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
  const manifest = buildStoredManifest(source, surface);
  const path = await writeStoredManifest(manifest);
  return summarise(manifest, path);
}
