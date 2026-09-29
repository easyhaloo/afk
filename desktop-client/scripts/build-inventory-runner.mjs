/**
 * Verifies or builds the standalone inventory runner for clean desktop installs.
 * The runner is a pre-bundled CLI that enumerates global work-item inventory
 * across all configured tracker providers (GitHub, GitLab, etc.).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'dist-electron', 'cli');
const outFile = join(outDir, 'inventory-runner.cjs');

async function main() {
  // Ensure output directory exists
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  // The inventory runner is a pre-bundled standalone CLI. If it already exists
  // and is non-empty, assume it is valid.
  if (existsSync(outFile)) {
    const stat = statSync(outFile);
    if (stat.size > 1024) {
      console.log('inventory-runner.cjs already exists, skipping');
      return;
    }
  }

  // If the runner does not exist or is empty, create a minimal stub.
  // This stub provides the CLI entry point so the desktop app can launch
  // the inventory subprocess without errors on first install.
  const stub = `#!/usr/bin/env node
/**
 * AFK Inventory Runner stub — populated by the full build pipeline.
 * This stub allows the desktop app to start without errors when the
 * bundled runner is not yet available.
 */
'use strict';
const { collectGlobalWorkItemInventory } = require('./inventory-runner-impl.cjs');
const catalogArg = process.argv.find(a => a.startsWith('--catalog='));
const catalogs = catalogArg ? JSON.parse(catalogArg.slice('--catalog='.length)) : [];
collectGlobalWorkItemInventory(catalogs).then(result => {
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
`;
  writeFileSync(outFile, stub);
  console.log('Created inventory-runner.cjs stub');
}

main().catch(err => {
  console.error('build-inventory-runner failed:', err);
  process.exit(1);
});
