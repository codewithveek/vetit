import { describe, expect, it } from 'vitest';
import {
  computeManifestHash,
  computePerToolHashes,
  computeToolHash,
} from '../../../src/features/manifest/index.js';
import type { ManifestTool } from '../../../src/features/manifest/index.js';

/**
 * The point of the stripped-down copy is that it is noisy about what matters
 * and silent about what does not. Both halves are tested: a false alarm every
 * time a server reformats its own text is how a drift alert stops being read.
 */

const baseTool: ManifestTool = {
  name: 'search_docs',
  description: 'Searches the documentation index.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  annotations: { readOnlyHint: true, destructiveHint: false },
};

const otherTool: ManifestTool = {
  name: 'create_page',
  description: 'Creates a page.',
  inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
  annotations: { readOnlyHint: false, destructiveHint: true },
};

describe('what the hash ignores', () => {
  it('ignores the order tools arrive in', () => {
    expect(computeManifestHash([baseTool, otherTool])).toBe(
      computeManifestHash([otherTool, baseTool]),
    );
  });

  it('ignores the order of keys inside a tool', () => {
    const reordered: ManifestTool = {
      annotations: { destructiveHint: false, readOnlyHint: true },
      inputSchema: { properties: { query: { type: 'string' } }, type: 'object' },
      description: 'Searches the documentation index.',
      name: 'search_docs',
    };
    expect(computeToolHash(reordered)).toBe(computeToolHash(baseTool));
  });

  it('ignores reflowed whitespace and trailing spaces', () => {
    const reflowed: ManifestTool = {
      ...baseTool,
      description: '  Searches the\n\n  documentation   index.  ',
    };
    expect(computeToolHash(reflowed)).toBe(computeToolHash(baseTool));
  });

  it('ignores fields the review does not act on', () => {
    const withExtras: ManifestTool = { ...baseTool, title: 'Search docs' };
    expect(computeToolHash(withExtras)).toBe(computeToolHash(baseTool));
  });
});

describe('what the hash notices', () => {
  it('notices a changed description', () => {
    const changed: ManifestTool = { ...baseTool, description: 'Searches. <!-- x -->' };
    expect(computeToolHash(changed)).not.toBe(computeToolHash(baseTool));
  });

  it('notices a downgraded annotation', () => {
    const downgraded: ManifestTool = {
      ...otherTool,
      annotations: { readOnlyHint: true, destructiveHint: false },
    };
    expect(computeToolHash(downgraded)).not.toBe(computeToolHash(otherTool));
  });

  it('notices a new parameter', () => {
    const widened: ManifestTool = {
      ...baseTool,
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, sidenote: { type: 'string' } },
      },
    };
    expect(computeToolHash(widened)).not.toBe(computeToolHash(baseTool));
  });

  it('notices a tool being added', () => {
    expect(computeManifestHash([baseTool])).not.toBe(
      computeManifestHash([baseTool, otherTool]),
    );
  });
});

describe('per-tool hashes', () => {
  it('names every tool so a change can be attributed', () => {
    const hashes = computePerToolHashes([baseTool, otherTool]);
    expect(Object.keys(hashes).sort()).toEqual(['create_page', 'search_docs']);
  });

  it('changes only the entry for the tool that changed', () => {
    const before = computePerToolHashes([baseTool, otherTool]);
    const after = computePerToolHashes([
      baseTool,
      { ...otherTool, description: 'Creates a page, and more.' },
    ]);
    expect(after['search_docs']).toBe(before['search_docs']);
    expect(after['create_page']).not.toBe(before['create_page']);
  });

  it('treats a missing description as empty rather than failing', () => {
    const bare: ManifestTool = { name: 'bare' };
    expect(computeToolHash(bare)).toBe(
      computeToolHash({ name: 'bare', description: '', inputSchema: {}, annotations: {} }),
    );
  });
});
