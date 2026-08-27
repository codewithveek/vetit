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

export interface DecoyCliOptions {
  readonly port: number;
  readonly isPoisoned: boolean;
}

export function parseDecoyArguments(argv: readonly string[]): DecoyCliOptions {
  const portIndex = argv.indexOf('--port');
  const rawPort = portIndex === -1 ? undefined : argv[portIndex + 1];
  const parsedPort = rawPort === undefined ? Number.NaN : Number.parseInt(rawPort, 10);
  return {
    port: Number.isInteger(parsedPort) ? parsedPort : DEFAULT_PORT,
    isPoisoned: argv.includes('--poison'),
  };
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

if (isProcessEntrypoint(import.meta.url)) {
  startDecoy(parseDecoyArguments(process.argv.slice(2)));
}
