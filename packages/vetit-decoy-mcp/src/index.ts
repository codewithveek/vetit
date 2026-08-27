#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDecoyApp } from './decoy-server.js';

/**
 * vetit-decoy-mcp — an MCP server that is unsafe on purpose.
 *
 * It exists so that a review tool has a fixed, consenting target. Every flaw
 * it publishes maps to a documented, real-world attack. Do not deploy it, and
 * do not connect a production agent to it.
 *
 *   npx vetit-decoy-mcp                # the manifest as first published
 *   npx vetit-decoy-mcp --poison       # the manifest after a rug pull
 *   npx vetit-decoy-mcp --port 8931
 */

const DEFAULT_PORT = 8931;

/**
 * The whole argument must be digits.
 *
 * `Number.parseInt` reads a prefix and stops, so it turns `8931junk` into 8931
 * and `--poison` into NaN. Anchoring the pattern means a value is either a
 * port or an error, and never quietly a different port from the one asked for.
 */
const PORT_PATTERN = /^\d+$/;

/** Port 0 asks the OS to pick one. The CLI does not offer it — see below. */
const LOWEST_PORT = 1;
const HIGHEST_PORT = 65_535;

export const DECOY_USAGE = [
  'Usage: vetit-decoy-mcp [--poison] [--port <1-65535>]',
  '',
  '  --poison        publish the manifest as it looks after a rug pull',
  '  --port <n>      listen on this port (default 8931)',
].join('\n');

export interface DecoyCliOptions {
  readonly port: number;
  readonly isPoisoned: boolean;
}

/**
 * Either the options, or the reason there are none.
 *
 * A union rather than a throw or a `process.exit`, so the function stays pure
 * and importable — which is the reason anyone imports this module at all — and
 * the CLI wrapper is the only thing that decides to end the process.
 */
export type DecoyCliParse =
  | { readonly ok: true; readonly options: DecoyCliOptions }
  | { readonly ok: false; readonly message: string };

/**
 * Bad input is an error, not a fallback.
 *
 * Starting on 8931 because someone typed `--port 8931junk` means the server is
 * not where they think it is, and they find out later and somewhere else.
 * Port 0 is rejected for a related reason: the startup line prints the port,
 * and with 0 that line would be a lie. Tests that want an ephemeral port call
 * `createDecoyApp` directly and read the address off the server.
 */
export function parseDecoyArguments(argv: readonly string[]): DecoyCliParse {
  const isPoisoned = argv.includes('--poison');
  const portIndex = argv.indexOf('--port');
  if (portIndex === -1) {
    return { ok: true, options: { port: DEFAULT_PORT, isPoisoned } };
  }

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
  return { ok: true, options: { port, isPoisoned } };
}

function startDecoy(options: DecoyCliOptions): void {
  const app = createDecoyApp({ isPoisoned: options.isPoisoned });
  app.listen(options.port, '127.0.0.1', () => {
    const mode = options.isPoisoned ? 'POISONED (post rug-pull)' : 'baseline';
    process.stdout.write(
      `vetit-decoy-mcp listening on http://127.0.0.1:${String(options.port)}/mcp — ${mode}\n` +
        'This server is deliberately unsafe. Do not connect a production agent.\n',
    );
  });
}

/**
 * Is this module the file node was actually asked to run?
 *
 * The previous check asked only whether the module was called `index.js`,
 * which is true of this file however it is loaded — so importing the package
 * through its declared `main` bound port 8931 as a side effect. Anyone
 * importing it for `parseDecoyArguments` got a long-lived listener they never
 * asked for, and a second import got EADDRINUSE.
 *
 * Comparing real paths rather than URLs matters for the installed case: `npx`
 * puts a symlink in `node_modules/.bin`, so `process.argv[1]` and this
 * module's own path are two different names for one file. `realpathSync`
 * collapses both to the same answer, and throws for a path that does not
 * exist — which is not this module being the entrypoint either.
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
export function runDecoyCli(argv: readonly string[]): number {
  const parsed = parseDecoyArguments(argv);
  if (!parsed.ok) {
    process.stderr.write(`vetit-decoy-mcp: ${parsed.message}\n\n${DECOY_USAGE}\n`);
    return 1;
  }
  startDecoy(parsed.options);
  return 0;
}

if (isProcessEntrypoint(import.meta.url)) {
  process.exitCode = runDecoyCli(process.argv.slice(2));
}
