/**
 * fix-permissions.mjs
 *
 * Ensures node-pty's spawn helper is executable and, when installation was
 * performed by another user, attempts to normalize node_modules ownership.
 * The ownership fix is intentionally best-effort and never blocks CI.
 */
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const nodeModules = path.resolve('node_modules');

if (!fs.existsSync(nodeModules)) {
  process.exit(0);
}

function ensureNodePtyHelperExecutable() {
  if (process.platform === 'win32') return;

  const candidates = [
    path.join(nodeModules, 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    path.join(nodeModules, 'node-pty', 'build', 'Release', 'spawn-helper'),
  ];

  for (const helperPath of candidates) {
    if (!fs.existsSync(helperPath)) continue;
    try {
      const mode = fs.statSync(helperPath).mode;
      if ((mode & 0o111) === 0) {
        fs.chmodSync(helperPath, mode | 0o755);
        console.log(`[fix-permissions] enabled node-pty spawn helper: ${helperPath}`);
      }
    } catch (err) {
      console.warn(`[fix-permissions] Could not enable node-pty spawn helper: ${err.message}`);
    }
  }
}

ensureNodePtyHelperExecutable();

if (process.platform === 'win32' || typeof process.getuid !== 'function') {
  process.exit(0);
}

const currentUser = process.env.SUDO_USER || process.env.USER || os.userInfo().username;
const currentGroup = (() => {
  try {
    return execSync('id -gn', { encoding: 'utf-8' }).trim();
  } catch {
    return undefined;
  }
})();

try {
  const ownerUid = fs.statSync(nodeModules).uid;
  const currentUid = process.getuid();
  if (ownerUid === currentUid) {
    console.log(`[fix-permissions] node_modules already owned by ${currentUser}`);
    process.exit(0);
  }

  if (!currentGroup) {
    console.warn('[fix-permissions] Skipped: current group could not be determined');
    process.exit(0);
  }

  console.log(`[fix-permissions] Fixing ownership for ${nodeModules}`);
  execSync(
    `find ${JSON.stringify(nodeModules)} -not -user ${JSON.stringify(currentUser)} -exec chown ${JSON.stringify(`${currentUser}:${currentGroup}`)} {} +`,
    { stdio: 'inherit' }
  );
  console.log('[fix-permissions] Done');
} catch (err) {
  console.warn('[fix-permissions] Skipped:', err.message);
}
