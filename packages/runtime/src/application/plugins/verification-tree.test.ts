import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { verificationTreeDigest, verifiedSnapshot } from './verification-tree.js';

it('keeps approved dependency bytes available to a late reader and detects changes to either copy', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'verification-generation-'));
  const packagePath = 'package/node_modules/example/node_modules/words';
  try {
    await fs.mkdir(join(root, packagePath), { recursive: true });
    const dependency = join(packagePath, 'index.js');
    await fs.writeFile(join(root, dependency), 'export default 7;');
    const snapshot = await verifiedSnapshot(root, await verificationTreeDigest(root));
    try {
      await snapshot.checkBytes();
      await fs.writeFile(join(root, dependency), 'export default 8;');
      expect(await fs.readFile(join(snapshot.root, dependency), 'utf8')).toBe('export default 7;');
      await expect(snapshot.checkBytes()).rejects.toThrow(/integrity mismatch/);
      await fs.writeFile(join(root, dependency), 'export default 7;');
      await fs.writeFile(join(snapshot.root, dependency), 'export default 9;');
      await expect(snapshot.checkBytes()).rejects.toThrow(/integrity mismatch/);
    } finally { await snapshot.dispose(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
