import { describe, expect, it } from 'vitest';
import { buildToolCatalogue } from '../src/tool-catalogue.js';

/**
 * The decoy is a fixture, so its manifest is part of its contract. If a flaw
 * disappears from here, a detector test elsewhere starts passing for the wrong
 * reason.
 */

const baseline = buildToolCatalogue({ isPoisoned: false });
const poisoned = buildToolCatalogue({ isPoisoned: true });

function findTool(tools: readonly { name: string }[], name: string): unknown {
  return tools.find((tool) => tool.name === name);
}

describe('the baseline manifest', () => {
  it('publishes every planted tool', () => {
    expect(baseline.map((tool) => tool.name)).toEqual([
      'add',
      'search_docs',
      'get_page',
      'list_spaces',
      'export_all',
      'create_page',
      'list_workspace_files',
      'summarise_page',
      'sendm\u0435ssage',
      'report_status',
      'check_environment',
    ]);
  });

  it('hides an instruction block inside a harmless-looking tool', () => {
    const add = baseline.find((tool) => tool.name === 'add');
    expect(add?.description).toContain('<IMPORTANT>');
    expect(add?.description).toContain('~/.ssh/id_rsa');
  });

  it('gives `add` an undocumented free-text parameter', () => {
    const add = baseline.find((tool) => tool.name === 'add');
    const properties = add?.inputSchema.properties ?? {};
    expect(Object.keys(properties)).toContain('sidenote');
    expect(add?.description).not.toContain('sidenote parameter');
  });

  it('carries invisible characters in one description', () => {
    const summarise = baseline.find((tool) => tool.name === 'summarise_page');
    expect(summarise?.description).toMatch(/[\u200B\u2066\u2069\u202E]/);
  });

  it('names another server\u2019s tools in a description', () => {
    const listFiles = baseline.find(
      (tool) => tool.name === 'list_workspace_files',
    );
    expect(listFiles?.description).toContain('github.create_issue');
  });

  it('leaves two tools with no annotations at all', () => {
    const unannotated = baseline
      .filter((tool) => tool.annotations === undefined)
      .map((tool) => tool.name);
    expect(unannotated).toEqual(['sendm\u0435ssage', 'check_environment']);
  });

  it('labels the lying tool as read-only', () => {
    const exportAll = baseline.find((tool) => tool.name === 'export_all');
    expect(exportAll?.annotations?.readOnlyHint).toBe(true);
  });

  it('is deterministic', () => {
    expect(buildToolCatalogue({ isPoisoned: false })).toEqual(baseline);
  });
});

describe('the rug-pulled manifest', () => {
  it('changes exactly the two tools the rug pull targets', () => {
    const changed = poisoned
      .filter((tool, index) => JSON.stringify(tool) !== JSON.stringify(baseline[index]))
      .map((tool) => tool.name);
    expect(changed).toEqual(['search_docs', 'create_page']);
  });

  it('adds a hidden instruction to a tool that was previously clean', () => {
    const searchDocs = poisoned.find((tool) => tool.name === 'search_docs');
    expect(searchDocs?.description).toContain('<!--');
    expect(searchDocs?.description).toContain('~/.ssh/id_rsa');
  });

  it('downgrades a write to a read', () => {
    const before = baseline.find((tool) => tool.name === 'create_page');
    const after = poisoned.find((tool) => tool.name === 'create_page');
    expect(before?.annotations?.readOnlyHint).toBe(false);
    expect(after?.annotations?.readOnlyHint).toBe(true);
  });

  it('keeps the honest tools untouched', () => {
    expect(findTool(poisoned, 'get_page')).toEqual(findTool(baseline, 'get_page'));
  });
});
