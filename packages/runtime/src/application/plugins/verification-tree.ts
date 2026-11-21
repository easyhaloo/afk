import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verificationTreeDigest(directory: string): Promise<string> {
  if (!(await fs.lstat(directory)).isDirectory()) throw new Error('Invalid verification generation directory');
  const root = await fs.realpath(directory);
  const sdk = await fs.realpath(fileURLToPath(new URL('../../../', import.meta.url)));
  const hash = createHash('sha256');
  let files = 0;
  let bytes = 0;
  async function visit(path: string): Promise<void> {
    if (++files > 40000) throw new Error('Verification tree file limit exceeded');
    const name = relative(root, path).split(sep).join('/');
    const stat = await fs.lstat(path);
    let item: string[];
    if (stat.isDirectory()) {
      item = ['directory'];
      for (const child of (await fs.readdir(path)).sort()) await visit(join(path, child));
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > 256 * 1024 * 1024) throw new Error('Verification tree byte limit exceeded');
      item = ['file', createHash('sha256').update(await fs.readFile(path)).digest('hex')];
    } else if (stat.isSymbolicLink()) {
      const link = await fs.readlink(path);
      const target = await fs.realpath(path);
      const hostSdk = name.endsWith('/node_modules/@afk/runtime') && target === sdk;
      if (!hostSdk && (isAbsolute(link) || !target.startsWith(root + sep))) throw new Error('Verification link escapes installed tree');
      item = ['link', link];
    } else throw new Error('Unsupported verification tree entry');
    hash.update(JSON.stringify([name, ...item]) + '\n');
  }
  await visit(root);
  return `sha256-${hash.digest('base64')}`;
}

export async function verifiedSnapshot(directory: string, expected: string) {
  const check = async (root: string) => {
    if (await verificationTreeDigest(root) !== expected) throw new Error('Shared verification tree integrity mismatch');
  };
  await check(directory);
  const temporary = await fs.mkdtemp(join(tmpdir(), 'afk-verifier-'));
  const root = join(temporary, 'generation');
  const dispose = () => fs.rm(temporary, { recursive: true, force: true });
  try {
    await fs.cp(directory, root, { recursive: true, verbatimSymlinks: true });
    await check(root);
    return { root, dispose, checkBytes: () => Promise.all([check(directory), check(root)]) };
  } catch (error) {
    await dispose();
    throw error;
  }
}
