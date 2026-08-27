import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  isProcessEntrypoint,
  parseVetitArguments,
  type VetitCliOptions,
} from '../src/index.js';

/**
 * The same two defects the decoy had, and the same tests, because it was the
 * same copied code.
 *
 * It mattered more here: this module re-exports `createVetitApp` and
 * `createVetitMcpServer`, so it is explicitly meant to be imported — and the
 * old guard bound port 8930 for anyone who accepted the invitation.
 */

let scratch: string;
let realFile: string;
let otherFile: string;
const originalArgv1 = process.argv[1];

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'vetit-cli-'));
  realFile = join(scratch, 'index.js');
  otherFile = join(scratch, 'other-index.js');
  writeFileSync(realFile, '', 'utf8');
  writeFileSync(otherFile, '', 'utf8');
});

afterEach(() => {
  process.argv[1] = originalArgv1 ?? '';
});

function optionsFor(argv: readonly string[]): VetitCliOptions {
  const parsed = parseVetitArguments(argv);
  if (!parsed.ok) throw new Error(`expected success, got: ${parsed.message}`);
  return parsed.options;
}

function messageFor(argv: readonly string[]): string {
  const parsed = parseVetitArguments(argv);
  if (parsed.ok) throw new Error('expected a rejection, got options');
  return parsed.message;
}

describe('isProcessEntrypoint', () => {
  it('says yes when the module is the file node was asked to run', () => {
    process.argv[1] = realFile;
    expect(isProcessEntrypoint(pathToFileURL(realFile).href)).toBe(true);
  });

  it('says no for a different file that happens to be named index.js', () => {
    process.argv[1] = otherFile;
    expect(isProcessEntrypoint(pathToFileURL(realFile).href)).toBe(false);
  });

  it('says no when the module was imported for its exports', () => {
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

  it('sees through the symlink npx installs a bin as', (context) => {
    const link = join(scratch, 'vetit-mcp-link.js');
    try {
      symlinkSync(realFile, link, 'file');
    } catch {
      context.skip();
      return;
    }
    process.argv[1] = link;
    expect(isProcessEntrypoint(pathToFileURL(realFile).href)).toBe(true);
  });
});

describe('parseVetitArguments — what it accepts', () => {
  it('defaults to 8930 with no arguments', () => {
    expect(optionsFor([])).toEqual({ port: 8930 });
  });

  it('takes a port', () => {
    expect(optionsFor(['--port', '9000']).port).toBe(9000);
  });

  it('takes the ends of the valid range', () => {
    expect(optionsFor(['--port', '1']).port).toBe(1);
    expect(optionsFor(['--port', '65535']).port).toBe(65_535);
  });

  it('ignores arguments it does not know about', () => {
    expect(optionsFor(['--verbose', '--port', '9000']).port).toBe(9000);
  });
});

describe('parseVetitArguments — what it refuses', () => {
  it('refuses a numeric prefix rather than silently using it', () => {
    expect(messageFor(['--port', '9000junk'])).toContain('whole number');
  });

  it('refuses a negative port', () => {
    expect(messageFor(['--port', '-1'])).toContain('whole number');
  });

  it('refuses a port above the valid range', () => {
    expect(messageFor(['--port', '99999'])).toContain('between 1 and 65535');
  });

  it('refuses port 0, which would make the startup line a lie', () => {
    expect(messageFor(['--port', '0'])).toContain('between 1 and 65535');
  });

  it('refuses hex, which parseInt would have read as 0', () => {
    expect(messageFor(['--port', '0x20'])).toContain('whole number');
  });

  it('refuses --port with nothing after it', () => {
    expect(messageFor(['--port'])).toContain('requires a value');
  });

  it('refuses --port swallowing the next flag', () => {
    expect(messageFor(['--port', '--verbose'])).toContain('whole number');
  });

  it('names the value it refused, so the message is actionable', () => {
    expect(messageFor(['--port', '9000junk'])).toContain('9000junk');
  });
});
