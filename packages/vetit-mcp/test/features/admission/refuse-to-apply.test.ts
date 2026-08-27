import { describe, expect, it } from 'vitest';
import { findReasonToRefuse } from '../../../src/features/admission/index.js';
import { DETECTORS } from '../../../src/features/detection/index.js';
import type { ManifestSource, StoredManifest } from '../../../src/features/manifest/index.js';

/**
 * What stands between a review and a real permission change.
 *
 * Proposing costs nothing. Applying takes a server out of quarantine, and
 * review found two ways that could happen without a review having taken place
 * — or having taken place against a different server entirely.
 */

const ALL_DETECTORS = DETECTORS.map((definition) => definition.id);

function manifestFrom(source: ManifestSource): StoredManifest {
  return {
    manifestId: '01J0000000000000000000000M',
    fetchedAt: '2026-08-27T00:00:00.000Z',
    source,
    tools: [],
    unparseableToolCount: 0,
    resourceNames: [],
    promptNames: [],
    resourcesStatus: 'unsupported',
    promptsStatus: 'unsupported',
    manifestHash: 'hash',
    perToolHashes: {},
    duplicateToolNames: [],
    raw: { tools: [], pageCounts: { tools: 1, resources: 0, prompts: 0 } },
  };
}

const fromConnector = (name: string): StoredManifest =>
  manifestFrom({ kind: 'connector', connectorName: name });

describe('an unreviewed manifest', () => {
  it('is refused, whatever the connector', async () => {
    const reason = await findReasonToRefuse({
      manifest: fromConnector('target'),
      connectorName: 'target',
      detectorsRun: [],
    });
    expect(reason).toContain('has not been fully reviewed');
  });

  it('names the detectors that never ran', async () => {
    const reason = await findReasonToRefuse({
      manifest: fromConnector('target'),
      connectorName: 'target',
      detectorsRun: ['D-01', 'D-02', 'D-03'],
    });
    expect(reason).toContain('D-04');
    expect(reason).not.toContain('D-01,');
  });

  it('says what to run rather than only that it refused', async () => {
    const reason = await findReasonToRefuse({
      manifest: fromConnector('target'),
      connectorName: 'target',
      detectorsRun: [],
    });
    expect(reason).toContain('scan_descriptions');
  });

  it('is checked before the connector, since it applies either way', async () => {
    // A direct manifest would otherwise reach the connector lookup, which
    // needs a running harness. Refusing on coverage first keeps the common
    // mistake cheap to diagnose.
    const reason = await findReasonToRefuse({
      manifest: manifestFrom({ kind: 'direct', url: 'http://127.0.0.1:1/mcp' }),
      connectorName: 'target',
      detectorsRun: [],
    });
    expect(reason).toContain('has not been fully reviewed');
  });
});

describe('a review of a different server', () => {
  it('is refused when the connector names do not match', async () => {
    const reason = await findReasonToRefuse({
      manifest: fromConnector('reviewed-server'),
      connectorName: 'some-other-server',
      detectorsRun: ALL_DETECTORS,
    });
    expect(reason).toContain('reviewed-server');
    expect(reason).toContain('some-other-server');
  });

  it('is allowed when the connector is the one that was reviewed', async () => {
    const reason = await findReasonToRefuse({
      manifest: fromConnector('target'),
      connectorName: 'target',
      detectorsRun: ALL_DETECTORS,
    });
    expect(reason).toBeUndefined();
  });
});
