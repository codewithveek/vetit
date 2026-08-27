import { DETECTORS } from '../detection/index.js';
import type { StoredManifest } from '../manifest/index.js';
import { readConnector } from '../../shared/trueforge-client/index.js';

/**
 * The checks that stand between a review and a real permission change.
 *
 * Proposing a grant costs nothing and is allowed at any time. Applying one
 * takes a server out of quarantine, and review found two ways that could
 * happen without a review having taken place at all.
 */

const MANDATORY_DETECTORS: readonly string[] = DETECTORS.map(
  (definition) => definition.id,
);

export interface RefusalCheck {
  readonly manifest: StoredManifest;
  readonly connectorName: string;
  readonly detectorsRun: readonly string[];
}

/**
 * Was this manifest ever actually reviewed?
 *
 * A fetched-but-unscanned manifest has no findings, and no findings scored
 * zero, and zero was `admit_full`. Fetch a server and apply immediately and it
 * came out of quarantine with every tool enabled, having been checked by
 * nothing. The findings list could not tell "nothing was found" from "nothing
 * was looked for"; the coverage record can.
 */
function findUnreviewedReason(check: RefusalCheck): string | undefined {
  const missing = MANDATORY_DETECTORS.filter(
    (detector) => !check.detectorsRun.includes(detector),
  );
  if (missing.length === 0) return undefined;
  return (
    `This manifest has not been fully reviewed: ${missing.join(', ')} never ran. ` +
    'Run scan_descriptions, analyze_schemas, check_annotations and ' +
    'check_shadowing first. Refusing to release a server from quarantine on ' +
    'the strength of checks nobody performed.'
  );
}

/**
 * Is this the connector that was actually reviewed?
 *
 * `manifest_id` and `connector_name` were independent inputs and nothing tied
 * them together, so a review of one server could rewrite the permissions of
 * another — including releasing it.
 *
 * A connector-sourced manifest carries the connector's name and it must match.
 * A directly-fetched manifest carries a URL, so the connector is read back and
 * its URL has to be the endpoint that was reviewed. That is weaker than the
 * name check and the limit is worth stating: it proves the connector points
 * where the review looked *now*, not that it did throughout.
 */
async function findWrongConnectorReason(
  check: RefusalCheck,
): Promise<string | undefined> {
  const { source } = check.manifest;
  if (source.kind === 'connector') {
    return source.connectorName === check.connectorName
      ? undefined
      : `This manifest was fetched through connector ${source.connectorName}, ` +
          `not ${check.connectorName}. Refusing to apply one server's review ` +
          'to another.';
  }

  const record = await readConnector(check.connectorName);
  if (record.url === undefined) {
    return (
      `Connector ${check.connectorName} does not report a URL, so there is no ` +
      'way to confirm it is the server this manifest was fetched from. Fetch ' +
      'the manifest through the connector and review that instead.'
    );
  }
  return normaliseUrl(record.url) === normaliseUrl(source.url)
    ? undefined
    : `Connector ${check.connectorName} points at a different endpoint from ` +
        'the one this manifest was fetched from. Refusing to apply a review of ' +
        'one server to another.';
}

/** Enough to catch a trailing slash or a case difference in the host. */
function normaliseUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return value.trim().toLowerCase();
  }
}

export async function findReasonToRefuse(
  check: RefusalCheck,
): Promise<string | undefined> {
  return findUnreviewedReason(check) ?? (await findWrongConnectorReason(check));
}
