import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';

/**
 * Reading and writing files that hold something worth protecting.
 *
 * The writes are atomic: the content goes to a temporary file in the same
 * directory, the temporary file is tightened, and the rename puts it in
 * place in one step.  A reader sees either the old file or the new one,
 * never half of either, and a rename that fails leaves the old file alone
 * and removes the temporary one.
 *
 * Nothing fallible happens after the rename.  A chmod that failed there
 * would report a write that had already succeeded as a failure, and the
 * caller would retry it.
 */

/**
 * The file operations this module performs. `Pick<typeof fs, ...>` would also
 * carry fs's overloads (Buffer reads, append flags, bigint stats), which no
 * caller here uses and which a hand-written store cannot satisfy.
 */
export type AtomicFileSystem = {
  chmod(path: string, mode: number): Promise<void>;
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
  writeFile(path: string, data: string, options: { encoding?: 'utf8'; mode: number }): Promise<void>;
};

type FileSystem = Pick<AtomicFileSystem, 'chmod' | 'mkdir' | 'rename' | 'rm' | 'writeFile'>;

/**
 * Write a file atomically.
 *
 * The caller owns the directory: this writes the file and nothing else, so
 * a caller that manages a directory of its own — the user's `.ssh`, say —
 * keeps managing it.
 */
export async function writeFileAtomic(
  file: string,
  contents: string,
  fileSystem: FileSystem,
  mode = 0o600,
): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fileSystem.writeFile(temporary, contents, { encoding: 'utf8', mode });
    await fileSystem.chmod(temporary, mode);
    await fileSystem.rename(temporary, file);
  } catch (error) {
    await fileSystem.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Write text to a file atomically, in a directory only AFK owns: the
 * directory is created 0o700 and tightened to 0o700.
 */
export async function writeTextFileAtomic(
  file: string,
  contents: string,
  fileSystem: FileSystem = fs as FileSystem,
): Promise<void> {
  await ensurePrivateDirectory(file, fileSystem);
  await writeFileAtomic(file, contents, fileSystem);
}

/**
 * Writes data to a JSON file atomically: mkdir 0o700, tmp file, mode 0o600, rename.
 */
export async function writeJsonFileAtomic(
  file: string,
  data: unknown,
  fileSystem: FileSystem = fs as FileSystem,
): Promise<void> {
  await writeTextFileAtomic(file, `${JSON.stringify(data)}\n`, fileSystem);
}

/**
 * Reads a JSON file, returning an empty default on ENOENT or parse failure.
 */
export async function readJsonFile<T>(
  file: string,
  parse: (raw: unknown) => T,
  fileSystem: Pick<AtomicFileSystem, 'readFile'> = fs,
): Promise<T> {
  let raw: string;
  try {
    raw = await fileSystem.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return parse(undefined);
    throw error;
  }
  try {
    return parse(JSON.parse(raw));
  } catch {
    return parse(undefined);
  }
}

/**
 * Reads a YAML file, returning an empty default on ENOENT or parse failure.
 */
export async function readYamlFile<T>(
  file: string,
  parse: (raw: unknown) => T,
  fileSystem: Pick<AtomicFileSystem, 'readFile'> = fs,
): Promise<T> {
  let raw: string;
  try {
    raw = await fileSystem.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return parse(undefined);
    throw error;
  }
  try {
    return parse(loadYaml(raw));
  } catch {
    return parse(undefined);
  }
}

/**
 * Writes data to a YAML file atomically: mkdir 0o700, tmp file, mode 0o600, rename.
 */
export async function writeYamlFileAtomic(
  file: string,
  data: unknown,
  fileSystem: FileSystem = fs as FileSystem,
): Promise<void> {
  await writeTextFileAtomic(file, dumpYaml(data, { noRefs: true, lineWidth: -1 }), fileSystem);
}

async function ensurePrivateDirectory(file: string, fileSystem: FileSystem): Promise<void> {
  const directory = path.dirname(file);
  await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
  await fileSystem.chmod(directory, 0o700);
}
