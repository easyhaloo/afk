#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const skillRoot = path.resolve(new URL('..', import.meta.url).pathname, '..');
const packageFile = path.join(skillRoot, 'package.json');

function run(command, args) {
  const child = spawn(command, args, { cwd: skillRoot, stdio: 'inherit' });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

async function main() {
  if (!fs.existsSync(packageFile)) throw new Error(`Missing ${packageFile}`);
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ]);
  console.log(`Installed the native Jev SDK in ${skillRoot}`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
