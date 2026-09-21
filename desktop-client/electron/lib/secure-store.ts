import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";

type FileSystem = Pick<typeof fs, "chmod" | "mkdir" | "readFile" | "rename" | "rm" | "writeFile">;

/**
 * Reads a JSON file, returning an empty default on ENOENT or parse failure.
 */
export async function readJsonFile<T>(
  file: string,
  parse: (raw: unknown) => T,
  fileSystem: Pick<typeof fs, "readFile"> = fs,
): Promise<T> {
  let raw: string;
  try {
    raw = await fileSystem.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parse(undefined);
    throw error;
  }
  try {
    return parse(JSON.parse(raw));
  } catch {
    return parse(undefined);
  }
}

/**
 * Writes data to a JSON file atomically: mkdir 0o700, tmp file, mode 0o600, rename, chmod, rm tmp on error.
 */
export async function writeJsonFileAtomic(
  file: string,
  data: unknown,
  fileSystem: Pick<typeof fs, "chmod" | "mkdir" | "rename" | "rm" | "writeFile"> = fs,
): Promise<void> {
  await fileSystem.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fileSystem.writeFile(temporary, `${JSON.stringify(data)}\n`, { encoding: "utf8", mode: 0o600 });
    await fileSystem.chmod(temporary, 0o600);
    await fileSystem.rename(temporary, file);
  } catch (error) {
    await fileSystem.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Reads a YAML file, returning an empty default on ENOENT or parse failure.
 */
export async function readYamlFile<T>(
  file: string,
  parse: (raw: unknown) => T,
  fileSystem: Pick<typeof fs, "readFile"> = fs,
): Promise<T> {
  let raw: string;
  try {
    raw = await fileSystem.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parse(undefined);
    throw error;
  }
  try {
    return parse(loadYaml(raw));
  } catch {
    return parse(undefined);
  }
}

/**
 * Writes data to a YAML file atomically: mkdir 0o700, tmp file, mode 0o600, rename, chmod, rm tmp on error.
 */
export async function writeYamlFileAtomic(
  file: string,
  data: unknown,
  fileSystem: FileSystem = fs as FileSystem,
): Promise<void> {
  await fileSystem.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fileSystem.writeFile(temporary, dumpYaml(data, { noRefs: true, lineWidth: -1 }), { encoding: "utf8", mode: 0o600 });
    await fileSystem.chmod(temporary, 0o600);
    await fileSystem.rename(temporary, file);
    await fileSystem.chmod(file, 0o600);
  } catch (error) {
    await fileSystem.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
