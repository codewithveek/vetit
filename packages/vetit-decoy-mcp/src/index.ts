#!/usr/bin/env node
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

if (process.argv[1] !== undefined && import.meta.url.endsWith('index.js')) {
  startDecoy(parseDecoyArguments(process.argv.slice(2)));
}
