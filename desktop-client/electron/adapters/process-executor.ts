import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

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

function diagnosticEnvironment(cwd?: string) {
  return {
    ...process.env,
    PATH: diagnosticPath(),
    ...(cwd ? { PWD: cwd } : {}),
  };
}

export async function exec(
  command: string,
  args: string[],
  cwd?: string,
  input?: string,
  options: { timeoutMs?: number; maxBuffer?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const maxBuffer = options.maxBuffer ?? 2_000_000;
  return new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: diagnosticEnvironment(cwd),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (ok: boolean, errorText?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok,
        stdout: stdout.trim(),
        stderr: (errorText !== undefined ? errorText : stderr).trim(),
      });
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false, stderr || `${command} timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length + stderr.length > maxBuffer) {
        child.kill("SIGKILL");
        finish(false, stderr || `${command} output exceeded ${maxBuffer} bytes`);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stdout.length + stderr.length > maxBuffer) {
        child.kill("SIGKILL");
        finish(false, stderr || `${command} output exceeded ${maxBuffer} bytes`);
      }
    });
    child.on("error", (error) => finish(false, error.message));
    child.on("close", (code) => finish(code === 0));

    if (input !== undefined) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
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
