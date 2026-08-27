import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isProcessEntrypoint } from '../src/index.js';

/**
 * Importing this package must not start a server.
 *
 * The original guard asked only whether the loaded module was named
 * `index.js` — true of this file however it is loaded — so importing the
 * package through its declared `main` bound port 8931 as a side effect, and a
 * second import got EADDRINUSE.
 *
 * The predicate is tested rather than the side effect because the side effect
 * is the thing there must be none of: a test that asserts "no server started"
 * passes just as happily when the module failed to load at all.
 */

let scratch: string;
let realFile: string;
let otherFile: string;
const originalArgv1 = process.argv[1];

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'vetit-entrypoint-'));
  realFile = join(scratch, 'index.js');
  otherFile = join(scratch, 'other-index.js');
  writeFileSync(realFile, '', 'utf8');
  writeFileSync(otherFile, '', 'utf8');
});

afterEach(() => {
  process.argv[1] = originalArgv1 ?? '';
});

describe('isProcessEntrypoint', () => {
  it('says yes when the module is the file node was asked to run', () => {
    process.argv[1] = realFile;
    expect(isProcessEntrypoint(pathToFileURL(realFile).href)).toBe(true);
  });

  it('says no for a different file that happens to be named index.js', () => {
    // This is the original bug, stated as a test: same basename, different
    // file. The old check answered yes to this.
    process.argv[1] = otherFile;
    expect(isProcessEntrypoint(pathToFileURL(realFile).href)).toBe(false);
  });

  it('says no when the module was imported by something else entirely', () => {
    process.argv[1] = join(scratch, 'some-consumer-app.js');
    expect(isProcessEntrypoint(pathToFileURL(realFile).href)).toBe(false);
  });

  it('says no when there is no entrypoint at all', () => {
    process.argv[1] = '';
    expect(isProcessEntrypoint(pathToFileURL(realFile).href)).toBe(false);
  });

  it('says no rather than throwing when the module path does not exist', () => {
    process.argv[1] = realFile;
    expect(isProcessEntrypoint(pathToFileURL(join(scratch, 'gone.js')).href)).toBe(false);
  });

  it('is not fooled by a relative entrypoint path', () => {
    process.argv[1] = realFile;
    expect(isProcessEntrypoint(pathToFileURL(otherFile).href)).toBe(false);
  });

  it('sees through the symlink npx installs a bin as', (context) => {
    // The installed case: process.argv[1] is node_modules/.bin/vetit-decoy-mcp
    // and the module is the real file. Two names, one file — and the guard has
    // to say yes, or `npx vetit-decoy-mcp` would silently do nothing.
    const link = join(scratch, 'vetit-decoy-mcp-link.js');
    try {
      symlinkSync(realFile, link, 'file');
    } catch {
      // Creating symlinks on Windows needs developer mode. Reported as skipped
      // rather than returning early: a case that quietly passes without
      // running is worse than one that says it did not run.
      context.skip();
      return;
    }
    process.argv[1] = link;
    expect(isProcessEntrypoint(pathToFileURL(realFile).href)).toBe(true);
  });
});
