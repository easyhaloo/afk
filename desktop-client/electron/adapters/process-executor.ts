import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

function diagnosticPath() {
  const home = homedir();
  const entries = [
    ...(process.env.PATH || "").split(path.delimiter),
    path.join(home, "Library", "pnpm"),
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter((entry, index, values) => entry && values.indexOf(entry) === index);
  return entries.join(path.delimiter);
}

function diagnosticEnvironment() {
  return { ...process.env, PATH: diagnosticPath() };
}

export async function exec(command: string, args: string[], cwd?: string) {
  try {
    const { stdout, stderr } = await run(command, args, { cwd, env: diagnosticEnvironment(), timeout: 8_000, maxBuffer: 2_000_000 });
    return { ok: true, stdout: String(stdout).trim(), stderr: String(stderr).trim() } as const;
  } catch (error) {
    return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) } as const;
  }
}

export function firstLine(value: string, fallback: string) {
  return value.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 160) || fallback;
}

export async function executable(name: string) {
  const result = await exec("/usr/bin/which", [name]);
  const candidate = result.ok ? firstLine(result.stdout, "") : "";
  if (!candidate || !path.isAbsolute(candidate)) return "";
  return fs.realpath(candidate).catch(() => candidate);
}
