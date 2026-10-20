#!/usr/bin/env node
/**
 * Benchmark: the desktop client's in-process call against a spawned AFK CLI.
 *
 * Both sides do exactly the same work against the same provider, so the
 * difference is the cost of the process boundary: a fresh Node runtime, a
 * fresh module graph, a fresh provider client, and a JSON envelope to
 * translate in both directions.
 *
 *   node scripts/benchmark-cli-vs-direct.mjs [--workspace <dir>] [--iterations <n>]
 *
 * The measurement is paired. Each iteration runs the direct call and the
 * spawned call back to back, and the reported figure is the per-iteration
 * difference. Provider calls are network bound and vary by seconds between
 * runs, so comparing two independently averaged runs measures the weather,
 * not the boundary; pairing cancels that drift, because both sides of a pair
 * meet the same network.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const workspace = resolve(arg('--workspace', repoRoot));
const iterations = Number(arg('--iterations', '5'));
// A pause between rounds. The scoped inventory listing uses the issue search
// endpoint, whose rate limit is an order of magnitude tighter than the
// repository endpoints, so back-to-back rounds can push it into a secondary
// limit and make the direct side fall back to the per-project listing.
const pauseMs = Number(arg('--pause', '0'));
const cliEntry = join(repoRoot, 'dist', 'index.js');

if (!existsSync(cliEntry)) {
  console.error(`missing ${cliEntry} — run \`pnpm build\` first`);
  process.exit(1);
}

const { createGlobalWorkItemCatalogs, createManagementProviders } = await import(
  join(repoRoot, 'packages', 'afk-infrastructure', 'dist', 'provider', 'tracker-provider-factory.js')
);
const { collectGlobalWorkItemInventory } = await import(
  join(repoRoot, 'packages', 'afk-application', 'dist', 'work-items', 'inventory.js')
);
const { AFK_VERSION } = await import(
  join(repoRoot, 'packages', 'afk-application', 'dist', 'version.js')
);

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    n: sorted.length,
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/**
 * Run the two sides back to back, once per iteration, and collect the paired
 * difference as well as each side's own timings.
 */
async function paired(directAction, spawnAction) {
  const direct = [];
  const spawn = [];
  const deltas = [];
  for (let index = 0; index < iterations; index += 1) {
    let directStart = performance.now();
    await directAction();
    const directElapsed = performance.now() - directStart;

    const spawnStart = performance.now();
    await spawnAction();
    const spawnElapsed = performance.now() - spawnStart;

    direct.push(directElapsed);
    spawn.push(spawnElapsed);
    deltas.push(spawnElapsed - directElapsed);
    if (pauseMs > 0 && index < iterations - 1) {
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }
  return { direct: summarize(direct), spawn: summarize(spawn), delta: summarize(deltas), deltas };
}

function report(name, result) {
  const { direct, spawn, delta, deltas } = result;
  console.log(`  ${name}`);
  console.log(
    `    direct  p50 ${direct.p50.toFixed(0).padStart(6)}ms   p95 ${direct.p95.toFixed(0).padStart(6)}ms   min ${direct.min.toFixed(0).padStart(6)}ms`,
  );
  console.log(
    `    spawn   p50 ${spawn.p50.toFixed(0).padStart(6)}ms   p95 ${spawn.p95.toFixed(0).padStart(6)}ms   min ${spawn.min.toFixed(0).padStart(6)}ms`,
  );
  console.log(
    `    paired delta (spawn - direct): p50 ${delta.p50 >= 0 ? '+' : ''}${delta.p50.toFixed(0).padStart(6)}ms   ` +
    `p95 ${delta.p95 >= 0 ? '+' : ''}${delta.p95.toFixed(0).padStart(6)}ms   ` +
    `mean ${(delta.p50 >= 0 ? '+' : '')}${delta.p50.toFixed(0)}ms`,
  );
  console.log(`    spawn costs more in ${delta.p50 >= 0 ? 'most' : 'fewer'} iterations: ` +
    `${deltas.filter((value) => value > 0).length}/${deltas.length}`);
}

console.log(`workspace: ${workspace}`);
console.log(`iterations: ${iterations} paired rounds per operation`);
console.log(`pause between rounds: ${pauseMs}ms\n`);

// --- 1. the boundary with no provider work at all: the version the desktop
// used to probe for before every work item start.
console.log('runtime version (no provider work)');
{
  const result = await paired(
    async () => { AFK_VERSION; },
    async () => { await run(process.execPath, [cliEntry, '--version'], { cwd: workspace }); },
  );
  report('afk --version', result);
}

// --- 2. the capability probe the desktop ran before every work item start.
// After the refactor the capability is a static import: the module is loaded
// once when the main process starts, and the probe disappears entirely. The
// direct side therefore costs nothing at call time.
console.log('\ncapability probe (execute --help)');
{
  const { executeWorkItem } = await import(
    join(repoRoot, 'packages', 'afk-execution', 'dist', 'application', 'workflows', 'execute-work-item.js')
  );
  if (typeof executeWorkItem !== 'function') throw new Error('executeWorkItem is not callable');
  const result = await paired(
    async () => { /* the capability is a static import: nothing to do per call */ },
    async () => { await run(process.execPath, [cliEntry, 'execute', '--help'], { cwd: workspace }); },
  );
  report('execute --help', result);
}

// --- 3. backlog list: one repository's backlog, the read the desktop does
console.log('\nbacklog list (one repository)');
{
  let warmBundle;
  const result = await paired(
    async () => {
      warmBundle ??= await createManagementProviders(undefined, workspace);
      await warmBundle.backlog.list({});
    },
    async () => {
      await run(process.execPath, [cliEntry, 'backlog', 'list', '--json'], { cwd: workspace, maxBuffer: 32 * 1024 * 1024 });
    },
  );
  report('backlog list (warm provider)', result);
}

// --- 4. the global inventory: every credential-accessible project
console.log('\nwork item inventory (every project)');
{
  let warmCatalogs;
  const result = await paired(
    async () => {
      warmCatalogs ??= createGlobalWorkItemCatalogs('all');
      await collectGlobalWorkItemInventory(warmCatalogs);
    },
    async () => {
      await run(process.execPath, [cliEntry, 'backlog', 'inventory', '--json'], { cwd: workspace, maxBuffer: 64 * 1024 * 1024 });
    },
  );
  report('backlog inventory (warm catalog)', result);
}
