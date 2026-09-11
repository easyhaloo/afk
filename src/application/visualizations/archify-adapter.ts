import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ArchifyCommand { readonly executable: string; readonly args: readonly string[]; }
export interface ArchifyAdapterOptions { readonly executable?: string; readonly run?: (command: ArchifyCommand) => Promise<{ readonly stdout: string; readonly stderr?: string }>; }

function assertPath(value: string, name: string): void {
  if (!value || !isAbsolute(value) || value.includes('\0')) throw new Error(`${name} must be an absolute path`);
}

export function buildArchifyCommands(input: string, output: string, executable = 'archify'): { readonly validate: ArchifyCommand; readonly deliver: ArchifyCommand } {
  assertPath(input, 'input'); assertPath(output, 'output');
  return {
    validate: { executable, args: ['validate', 'workflow', input, '--quality', 'showcase', '--json'] },
    deliver: { executable, args: ['deliver', 'workflow', input, output, '--quality', 'showcase', '--json'] },
  };
}

export async function runArchifyAdapter(input: string, output: string, options: ArchifyAdapterOptions = {}): Promise<{ available: boolean; validated: boolean; delivered: boolean; version?: string; error?: string }> {
  const executable = options.executable ?? 'archify';
  const commands = buildArchifyCommands(input, output, executable);
  const executor = options.run ?? (async (command: ArchifyCommand) => {
    const result = await run(command.executable, [...command.args], { timeout: 30_000, maxBuffer: 4_000_000 });
    return { stdout: String(result.stdout), stderr: String(result.stderr ?? '') };
  });
  try {
    await access(executable, constants.X_OK).catch(() => { if (options.executable) throw new Error(`Archify executable is not available: ${executable}`); });
    const validated = await executor(commands.validate);
    const delivered = await executor(commands.deliver);
    return { available: true, validated: true, delivered: true, version: validated.stdout.trim() || undefined };
  } catch (error) {
    return { available: false, validated: false, delivered: false, error: error instanceof Error ? error.message : String(error) };
  }
}
