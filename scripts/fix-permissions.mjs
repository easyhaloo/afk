/**
 * fix-permissions.mjs
 *
 * Fixes node_modules ownership when installed by root or another user.
 * Runs automatically via postinstall, or manually: node scripts/fix-permissions.mjs
 */
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const nodeModules = path.resolve('node_modules');

if (!fs.existsSync(nodeModules)) {
  process.exit(0);
}

const currentUser = process.env.SUDO_USER || process.env.USER || execSync('whoami', { encoding: 'utf-8' }).trim();

try {
  const result = execSync(`stat -f "%Su" "${nodeModules}" 2>/dev/null`, { encoding: 'utf-8' });
  const owner = result.trim();

  if (owner === currentUser) {
    console.log(`[fix-permissions] node_modules already owned by ${currentUser}`);
    process.exit(0);
  }

  console.log(`[fix-permissions] Fixing ownership: ${owner} → ${currentUser}`);

  // Only chown files/dirs owned by different user to avoid unnecessary operations
  execSync(
    `find node_modules -not -user "${currentUser}" -exec chown -R "${currentUser}:staff" {} + 2>/dev/null || true`,
    { stdio: 'inherit' }
  );

  console.log('[fix-permissions] Done');
} catch (err) {
  // Silently ignore errors (e.g., no permission to chown system dirs)
  console.warn('[fix-permissions] Skipped:', err.message);
}
