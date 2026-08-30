#!/usr/bin/env node
/**
 * One command: build both packages, start them, register everything with
 * TrueForge, and create the Vetit agent.
 *
 * This is Node rather than bash for one reason worth stating: Node is already
 * a hard dependency of this project and bash is not. The shell version needed
 * Git Bash on Windows, and `bash setup.sh` from PowerShell silently resolves
 * to the WSL launcher instead — which fails before the script is ever read.
 * A tester should not have to know that.
 *
 * Credentials go in `.env` (see `.env.example`). Nothing here writes a secret
 * anywhere, and nothing prints one.
 *
 * Everything binds to loopback. The decoy is deliberately unsafe — that is the
 * whole point of it — so nothing here is reachable from another machine.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(ROOT);

const BOLD = '\u001B[1m';
const RED = '\u001B[1;31m';
const RESET = '\u001B[0m';
const log = (message) => {
  process.stdout.write(`\n${BOLD}${message}${RESET}\n`);
};
const detail = (message) => {
  process.stdout.write(`  ${message}\n`);
};

class SetupError extends Error {}

// --- configuration ----------------------------------------------------------

/** `.env` is optional: without one every default below still works. */
function loadEnvironmentFile() {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}

function readEnv(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

/** git remotes are commonly ssh; TrueForge clones over https. */
function toHttpsRepoUrl(url) {
  const trimmed = url.trim().replace(/\.git$/, '');
  if (trimmed.startsWith('ssh://git@')) {
    return `https://${trimmed.slice('ssh://git@'.length)}`;
  }
  if (trimmed.startsWith('git@')) {
    return `https://${trimmed.slice('git@'.length).replace(':', '/')}`;
  }
  return trimmed;
}

function gitValue(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function buildConfig() {
  const collectorPort = readEnv('VETIT_COLLECTOR_PORT', '8999');
  return {
    trueforgeUrl: readEnv('TRUEFORGE_BASE_URL', 'http://localhost:8790').replace(
      /\/+$/,
      '',
    ),
    vetitPort: readEnv('VETIT_PORT', '8930'),
    decoyPort: readEnv('DECOY_PORT', '8931'),
    collectorPort,
    collectorPublicUrl: readEnv(
      'VETIT_COLLECTOR_PUBLIC_URL',
      `http://127.0.0.1:${collectorPort}/collect`,
    ),
    canaryValue: readEnv('VETIT_CANARY_VALUE', 'vetit-canary-not-a-real-secret'),
    // The address TrueForge is told to reach these servers on. Loopback is
    // right when TrueForge runs on this machine; one in a container needs an
    // address meaning "the host" or every connector points at itself.
    advertisedHost: readEnv('VETIT_ADVERTISED_HOST', '127.0.0.1'),
    startupTimeoutMs: Number(readEnv('VETIT_STARTUP_TIMEOUT', '60')) * 1000,
    startTrueforge: readEnv('START_TRUEFORGE', 'false') === 'true',
    exaApiKey: readEnv('EXA_API_KEY', ''),
    exaUrl: readEnv('EXA_MCP_URL', 'https://mcp.exa.ai/mcp'),
    skill: {
      name: 'vetit-review',
      path: readEnv('VETIT_SKILL_PATH', 'skills/vetit-review'),
      ref: readEnv('VETIT_SKILL_REF', gitValue(['rev-parse', '--abbrev-ref', 'HEAD'])),
      url: readEnv(
        'VETIT_SKILL_REPO_URL',
        toHttpsRepoUrl(gitValue(['config', '--get', 'remote.origin.url'])),
      ),
      description:
        'Review an MCP server before it is trusted, and produce a ' +
        'least-privilege permission list a human approves.',
    },
  };
}

// --- http -------------------------------------------------------------------

/**
 * Every settings write is wrapped in `manifest`, and the schemas are closed —
 * an unrecognised key is a 400 rather than an ignored field. Learned by
 * running against a real harness, not by reading.
 */
async function sendJson(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, text: await response.text() };
}

/**
 * Setup gets re-run — after a reboot, after a port change, by a judge reading
 * the README twice. Creating is not idempotent, so a conflict becomes a
 * replace.
 */
async function upsert(label, url, body) {
  const created = await sendJson('POST', url, body);
  if (created.status < 300) return;
  if (created.status === 409) {
    detail('already registered — replacing');
    const replaced = await sendJson('PUT', url, body);
    if (replaced.status < 300) return;
    throw new SetupError(`${label} failed: HTTP ${replaced.status}\n${replaced.text}`);
  }
  throw new SetupError(`${label} failed: HTTP ${created.status}\n${created.text}`);
}

async function isReachable(url) {
  try {
    // Any HTTP answer means the listener is up. An MCP endpoint answers a bare
    // GET with an error, and an error is an answer.
    await fetch(url, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

// --- processes --------------------------------------------------------------

const children = [];

function runToCompletion(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new SetupError(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
}

function startBackground(name, command, options) {
  const child = spawn(command, options.args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...options.env },
  });
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  const record = { name, child, hasExited: () => exited };
  children.push(record);
  return record;
}

function stopChildren() {
  for (const record of children) {
    if (!record.hasExited()) record.child.kill();
  }
}

/**
 * Nothing may already be on the port we are about to take.
 *
 * Without this, readiness was satisfied by *somebody else's* listener: our
 * server died of EADDRINUSE, the port answered anyway, and setup went on to
 * register everything and print "Ready" for two processes that no longer
 * existed. A check that a port answers is not a check that our process is the
 * one answering.
 */
async function assertPortFree(name, url) {
  if (!(await isReachable(url))) return;
  throw new SetupError(
    `Something is already listening at ${url}, so ${name} cannot start there.\n` +
      'Stop it first, or set a different port in .env. Setup will not adopt a\n' +
      'server it did not start: it has no way to know what that server is.',
  );
}

/**
 * A fixed sleep is a guess. If a port was taken the process is already gone by
 * the time registration runs, and setup would announce readiness for a server
 * nobody can reach. Watch the child and the port together.
 */
async function waitForServer(record, options) {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (record.hasExited()) {
      throw new SetupError(
        `${record.name} exited during startup — see the output above; an ` +
          'occupied port is the usual cause.',
      );
    }
    // Reachable *and* still ours. The child can die between the two checks,
    // and a dead child with a live port is the case worth catching.
    if ((await isReachable(options.url)) && !record.hasExited()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new SetupError(
    `${record.name} did not answer at ${options.url} within ` +
      `${String(options.timeoutMs / 1000)}s.`,
  );
}

// --- phases -----------------------------------------------------------------

async function startTrueforge(config) {
  if (await isReachable(`${config.trueforgeUrl}/api/v1/settings/mcp-servers`)) {
    detail('already running');
    return;
  }
  if (!config.startTrueforge) {
    detail(`not running at ${config.trueforgeUrl}, and START_TRUEFORGE is not true`);
    return;
  }
  log('Starting TrueForge');
  const record = startBackground('trueforge', 'npx', {
    args: ['-y', '@truefoundry/trueforge@latest'],
    env: {},
  });
  await waitForServer(record, {
    url: `${config.trueforgeUrl}/api/v1/settings/mcp-servers`,
    timeoutMs: Math.max(config.startupTimeoutMs, 180_000),
  });
}

async function startBothServers(config) {
  await assertPortFree('vetit-mcp', `http://127.0.0.1:${config.vetitPort}/mcp`);
  await assertPortFree('vetit-decoy-mcp', `http://127.0.0.1:${config.decoyPort}/mcp`);

  log(`Starting vetit-mcp on 127.0.0.1:${config.vetitPort}`);
  const vetit = startBackground('vetit-mcp', 'node', {
    args: ['packages/vetit-mcp/dist/index.js', '--port', config.vetitPort],
    env: {
      VETIT_COLLECTOR_PORT: config.collectorPort,
      VETIT_COLLECTOR_PUBLIC_URL: config.collectorPublicUrl,
      VETIT_CANARY_VALUE: config.canaryValue,
    },
  });

  // The decoy is pointed at Vetit's tripwire collector and given a worthless
  // secret to steal, so that probe_tool has something to catch it doing.
  log(`Starting vetit-decoy-mcp on 127.0.0.1:${config.decoyPort}`);
  const decoy = startBackground('vetit-decoy-mcp', 'node', {
    args: ['packages/vetit-decoy-mcp/dist/index.js', '--port', config.decoyPort],
    env: {
      VETIT_DECOY_COLLECTOR_URL: `http://127.0.0.1:${config.collectorPort}/collect`,
      VETIT_CANARY_TOKEN: config.canaryValue,
    },
  });

  log('Waiting for both servers');
  const timeoutMs = config.startupTimeoutMs;
  await waitForServer(vetit, {
    url: `http://127.0.0.1:${config.vetitPort}/mcp`,
    timeoutMs,
  });
  await waitForServer(decoy, {
    url: `http://127.0.0.1:${config.decoyPort}/mcp`,
    timeoutMs,
  });
}

async function registerConnectors(config) {
  log('Registering the Vetit MCP server as a TrueForge connector');
  await upsert('connector registration', `${config.trueforgeUrl}/api/v1/settings/mcp-servers`, {
    manifest: {
      type: 'remote',
      name: 'vetit',
      url: `http://${config.advertisedHost}:${config.vetitPort}/mcp`,
      description: 'Vetit - reviews an MCP server before it is trusted.',
    },
  });

  if (config.exaApiKey === '') return false;
  log('Registering the exa connector');
  await upsert('exa registration', `${config.trueforgeUrl}/api/v1/settings/mcp-servers`, {
    manifest: {
      type: 'remote',
      name: 'exa',
      url: config.exaUrl,
      description: 'Exa search, used for the advisory cross-check.',
      auth: {
        type: 'header',
        headers: { Authorization: `Bearer ${config.exaApiKey}` },
      },
    },
  });
  return true;
}

/**
 * Before the agent, not after: the manifest's `skills` block is a reference by
 * name, and TrueForge rejects an agent naming a skill nobody registered.
 */
async function registerSkill(config) {
  log(`Registering the ${config.skill.name} skill`);
  if (config.skill.url === '') {
    throw new SetupError(
      'No git remote, so the skill has no repository to be fetched from. Set ' +
        'VETIT_SKILL_REPO_URL in .env to an HTTPS url TrueForge can clone.',
    );
  }
  detail(`${config.skill.url} — ${config.skill.path} @ ${config.skill.ref}`);
  await upsert('skill registration', `${config.trueforgeUrl}/api/v1/settings/skills`, {
    manifest: {
      type: 'git',
      name: config.skill.name,
      url: config.skill.url,
      ref: config.skill.ref,
      path: config.skill.path,
      description: config.skill.description,
    },
  });
}

/** Agents are replaced by immutable id, so a conflict means a lookup first. */
async function upsertAgent(config, manifest) {
  const url = `${config.trueforgeUrl}/api/v1/agents`;
  const created = await sendJson('POST', url, { name: 'vetit', manifest });
  if (created.status < 300) return;
  if (created.status !== 409) {
    throw new SetupError(agentFailureMessage(created));
  }
  detail('agent exists — replacing its manifest');
  const listed = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const found = (await listed.json()).data.find((agent) => agent.name === 'vetit');
  if (found === undefined) {
    throw new SetupError('The name vetit is taken but no such agent was listed.');
  }
  const replaced = await sendJson('PUT', `${url}/${found.id}`, { manifest });
  if (replaced.status >= 300) throw new SetupError(agentFailureMessage(replaced));
}

function agentFailureMessage(response) {
  return (
    `Agent creation failed: HTTP ${response.status}\n${response.text}\n\n` +
    'TrueForge will not create an agent without two things configured in its\n' +
    'settings:\n\n' +
    '  * a model provider, for the model in agent/vetit-agent.json\n' +
    '  * a sandbox provider, because the review playbook is a git-backed\n' +
    '    skill and skills are materialised in a sandbox\n\n' +
    'A local sandbox is used automatically on macOS and Linux. Windows has no\n' +
    'local provider, so one has to be registered before the agent will accept\n' +
    'the skill.'
  );
}

/**
 * Exa needs a key we have no business inventing, so when none is supplied the
 * connector is dropped from the manifest: a review that runs without the
 * cross-check, rather than a setup that will not start.
 */
async function createAgent(config, exaReady) {
  log('Creating the Vetit agent');
  const manifest = JSON.parse(await readFile(join(ROOT, 'agent/vetit-agent.json'), 'utf8'));
  if (!exaReady) {
    manifest.mcp_servers = manifest.mcp_servers.filter((entry) => entry.name !== 'exa');
  }
  await upsertAgent(config, manifest);
}

function printBanner(config, state) {
  log('Ready');
  process.stdout.write(
    `\n  vetit-mcp        http://127.0.0.1:${config.vetitPort}/mcp\n` +
      `  vetit-decoy-mcp  http://127.0.0.1:${config.decoyPort}/mcp   (deliberately unsafe)\n` +
      `  tripwire         http://127.0.0.1:${config.collectorPort}/collect\n\n` +
      (state.trueforgeReachable
        ? `  Ask the agent:  review the MCP server at http://127.0.0.1:${config.decoyPort}/mcp\n`
        : `  No TrueForge at ${config.trueforgeUrl}, so nothing was registered. Both\n` +
          '  servers are running and can be driven by any MCP client directly.\n') +
      (state.exaReady
        ? ''
        : '\n  No EXA_API_KEY, so the agent has no exa connector. Every pass runs\n' +
          '  except the advisory cross-check, and the report will say so.\n') +
      '\n  To see the label lie caught, the probe needs a reader nominated:\n' +
      '      probe_tool tool_name=export_all read_back_tool=list_spaces\n\n' +
      '  A tool that does not claim readOnlyHint: true is refused unless you\n' +
      '  also pass allow_non_read_only=true.\n\n' +
      '  To see the rug pull, restart the decoy with --poison and fetch again.\n\n' +
      '  Ctrl-C to stop everything.\n',
  );
}

// --- main -------------------------------------------------------------------

async function main() {
  const loaded = loadEnvironmentFile();
  const config = buildConfig();
  detail(loaded ? 'read .env' : 'no .env found — using defaults');

  log('Installing dependencies');
  await runToCompletion('npm', ['install']);
  log('Building both packages');
  await runToCompletion('npm', ['run', 'build']);

  await startTrueforge(config);
  await startBothServers(config);

  const state = { exaReady: false, trueforgeReachable: false };
  state.trueforgeReachable = await isReachable(
    `${config.trueforgeUrl}/api/v1/settings/mcp-servers`,
  );
  if (state.trueforgeReachable) {
    state.exaReady = await registerConnectors(config);
    await registerSkill(config);
    await createAgent(config, state.exaReady);
  }

  printBanner(config, state);
  // Hold the process open for the children. A bare never-resolving promise
  // makes Node exit 13 with an "unsettled top-level await" warning the moment
  // nothing else keeps the loop alive — which is exactly when something has
  // gone wrong and the message should say so.
  await new Promise((_resolve, reject) => {
    const watch = setInterval(() => {
      const dead = children.filter((record) => record.hasExited());
      if (dead.length > 0) {
        clearInterval(watch);
        reject(
          new SetupError(
            `${dead.map((record) => record.name).join(', ')} stopped. ` +
              'Everything else is being shut down.',
          ),
        );
      }
    }, 1000);
  });
}

process.on('SIGINT', () => {
  log('Stopping');
  stopChildren();
  process.exit(0);
});

try {
  await main();
} catch (error) {
  stopChildren();
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\n${RED}${message}${RESET}\n`);
  process.exit(1);
}
