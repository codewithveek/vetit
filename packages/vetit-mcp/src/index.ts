#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVetitApp } from './server.js';
import { resolveWorkdir } from './shared/workdir/index.js';

/**
 * vetit-mcp — review an MCP server before you trust it.
 *
 *   npx vetit-mcp                # listens on 127.0.0.1:8930
 *   npx vetit-mcp --port 9000
 *
 * Vetit is a defensive tool. Point it only at servers you own or have written
 * permission to test.
 *
 * The CLI plumbing below mirrors vetit-decoy-mcp's line for line. The
 * duplication is deliberate: these are two independently published packages,
 * and having one depend on the other for thirty lines of argument parsing
 * would be a worse trade than keeping them in step by hand.
 */

const DEFAULT_PORT = 8930;

/**
 * The whole argument must be digits.
 *
 * `Number.parseInt` reads a prefix and stops, so it turns `9000junk` into 9000
 * and `--verbose` into NaN. Anchoring the pattern means a value is either a
 * port or an error, and never quietly a different port from the one asked for.
 */
const PORT_PATTERN = /^\d+$/;

const LOWEST_PORT = 1;
const HIGHEST_PORT = 65_535;

export const VETIT_USAGE = [
  'Usage: vetit-mcp [--port <1-65535>]',
  '',
  '  --port <n>      listen on this port (default 8930)',
].join('\n');

export interface VetitCliOptions {
  readonly port: number;
}

/**
 * Either the options, or the reason there are none.
 *
 * A union rather than a throw or a `process.exit`, so the function stays pure
 * and importable, and the CLI wrapper is the only thing that ends the process.
 */
export type VetitCliParse =
  | { readonly ok: true; readonly options: VetitCliOptions }
  | { readonly ok: false; readonly message: string };

/**
 * Bad input is an error, not a fallback.
 *
 * Listening on 8930 because someone typed `--port 9000junk` means the server
 * is not where they think it is. Port 0 is refused for a related reason: the
 * startup line prints the port it bound, and with 0 that line would be a lie.
 * Tests that want an ephemeral port call `createVetitApp` directly.
 */
export function parseVetitArguments(argv: readonly string[]): VetitCliParse {
  const portIndex = argv.indexOf('--port');
  if (portIndex === -1) return { ok: true, options: { port: DEFAULT_PORT } };

  const rawPort = argv[portIndex + 1];
  if (rawPort === undefined) return { ok: false, message: '--port requires a value.' };
  if (!PORT_PATTERN.test(rawPort)) {
    return { ok: false, message: `--port must be a whole number, not "${rawPort}".` };
  }

  const port = Number.parseInt(rawPort, 10);
  if (port < LOWEST_PORT || port > HIGHEST_PORT) {
    return {
      ok: false,
      message:
        `--port must be between ${String(LOWEST_PORT)} and ${String(HIGHEST_PORT)}, ` +
        `not ${String(port)}.`,
    };
  }
  return { ok: true, options: { port } };
}

function startVetit(options: VetitCliOptions): void {
  createVetitApp().listen(options.port, '127.0.0.1', () => {
    process.stdout.write(
      `vetit-mcp listening on http://127.0.0.1:${String(options.port)}/mcp\n` +
        `workdir: ${resolveWorkdir()}\n`,
    );
  });
}

/**
 * Is this module the file node was actually asked to run?
 *
 * The previous check asked only whether the module was called `index.js`,
 * which is true of this file however it is loaded. This module exists to be
 * imported — it re-exports `createVetitApp` and `createVetitMcpServer` at the
 * bottom — so that guard bound port 8930 for every consumer who did exactly
 * what those exports invite, and a second import got EADDRINUSE.
 *
 * Comparing real paths rather than URLs matters for the installed case: `npx`
 * puts a symlink in `node_modules/.bin`, so `process.argv[1]` and this
 * module's own path are two different names for one file.
 */
export function isProcessEntrypoint(moduleUrl: string): boolean {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(entrypoint));
  } catch {
    return false;
  }
}

/** Returns the exit code. The only place that decides to give up. */
export function runVetitCli(argv: readonly string[]): number {
  const parsed = parseVetitArguments(argv);
  if (!parsed.ok) {
    process.stderr.write(`vetit-mcp: ${parsed.message}\n\n${VETIT_USAGE}\n`);
    return 1;
  }
  startVetit(parsed.options);
  return 0;
}

if (isProcessEntrypoint(import.meta.url)) {
  process.exitCode = runVetitCli(process.argv.slice(2));
}

export { createVetitApp, createVetitMcpServer } from './server.js';
