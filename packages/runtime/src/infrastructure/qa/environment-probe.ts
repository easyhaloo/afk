/**
 * Can the machine run this acceptance criterion's check command at all?
 *
 * A verification agent discovers a missing Django, a missing JDK or a missing
 * Maven by running into them — which takes as long as the agent's patience.
 * Probing first turns that into an answer in seconds.
 *
 * The probe only reports what is clearly environmental. A check command that
 * fails for any other reason is left to the agent: the preflight must not
 * block work that would have passed.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolRequirement } from '../../domain/tracker/ac-tools.js';
import { probeForTool } from '../../domain/tracker/ac-tools.js';

const execFileAsync = promisify(execFile);

/** A check command that cannot run here, and why. */
export interface EnvironmentBlocker {
  tool: string;
  criterion: string;
  checkCommand: string;
  /** What kind of absence it is. */
  kind: 'tool_missing' | 'dependency_missing' | 'runtime_missing';
  /** The probe's own words. */
  detail: string;
}

export interface EnvironmentProbeResult {
  /** Failures that are clearly environmental. */
  blockers: EnvironmentBlocker[];
  /** Failures that are not conclusive — the agent should try anyway. */
  inconclusive: EnvironmentBlocker[];
}

/** How long a probe may take before it is called inconclusive. */
const PROBE_TIMEOUT_MS = 45_000;

/**
 * Patterns that mean "this machine lacks something", as opposed to "the code
 * under test is wrong".
 */
const ENVIRONMENTAL: ReadonlyArray<{ pattern: RegExp; kind: EnvironmentBlocker['kind'] }> = [
  { pattern: /command not found/i, kind: 'tool_missing' },
  { pattern: /no such file or directory/i, kind: 'tool_missing' },
  { pattern: /is not recognized as an internal or external command/i, kind: 'tool_missing' },
  { pattern: /no module named ['"]?([\w.]+)/i, kind: 'dependency_missing' },
  { pattern: /cannot find module ['"]?([\w./-]+)/i, kind: 'dependency_missing' },
  { pattern: /java_home is not defined/i, kind: 'runtime_missing' },
  { pattern: /unable to locate a java runtime/i, kind: 'runtime_missing' },
  { pattern: /no java_home/i, kind: 'runtime_missing' },
  { pattern: /unsupported class file major version/i, kind: 'runtime_missing' },
  { pattern: /could not find or load main class/i, kind: 'runtime_missing' },
  { pattern: /unable to access jarfile/i, kind: 'runtime_missing' },
  { pattern: /no such file or directory:.*\.jar/i, kind: 'runtime_missing' },
];

/**
 * Classify a failed probe.
 *
 * Returns null when the failure is not clearly environmental — the caller
 * then lets the agent try the command itself.
 */
export function classifyProbeFailure(output: string): { kind: EnvironmentBlocker['kind']; detail: string } | null {
  for (const { pattern, kind } of ENVIRONMENTAL) {
    const match = output.match(pattern);
    if (match) {
      const detail = match[1] ? match[0].replace(match[1], match[1]).trim() : match[0].trim();
      return { kind, detail: detail || match[0].trim() };
    }
  }
  return null;
}

/**
 * Probe every tool the acceptance criteria need.
 *
 * The tool has to exist, and the probe has to run. A tool that is missing or
 * whose probe fails environmentally blocks the round; anything else is
 * reported as inconclusive and does not.
 */
export async function probeQaEnvironment(
  requirements: ToolRequirement[],
  worktreePath: string,
  options: { timeoutMs?: number } = {},
): Promise<EnvironmentProbeResult> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const blockers: EnvironmentBlocker[] = [];
  const inconclusive: EnvironmentBlocker[] = [];
  const probed = new Set<string>();

  for (const requirement of requirements) {
    if (probed.has(requirement.tool)) continue;
    probed.add(requirement.tool);

    const present = await commandExists(requirement.tool, worktreePath, timeoutMs);
    if (!present) {
      blockers.push({
        tool: requirement.tool,
        criterion: requirement.criterion,
        checkCommand: requirement.checkCommand,
        kind: 'tool_missing',
        detail: 'not installed on this machine',
      });
      continue;
    }

    const probe = probeForTool(requirement.tool, requirement.checkCommand);
    const outcome = await runProbe(probe.command, probe.args, worktreePath, timeoutMs);
    if (outcome.ok) continue;

    const classified = classifyProbeFailure(outcome.output);
    const entry: EnvironmentBlocker = {
      tool: requirement.tool,
      criterion: requirement.criterion,
      checkCommand: requirement.checkCommand,
      kind: classified?.kind ?? 'tool_missing',
      detail: classified?.detail ?? outcome.output.slice(0, 400),
    };
    if (classified) blockers.push(entry);
    else inconclusive.push(entry);
  }

  return { blockers, inconclusive };
}

async function commandExists(tool: string, cwd: string, timeoutMs: number): Promise<boolean> {
  const outcome = await runProbe('which', [tool], cwd, timeoutMs);
  if (outcome.ok) return true;
  // `which` itself may be missing; fall back to asking the shell.
  const fallback = await runProbe('/bin/sh', ['-c', `command -v ${JSON.stringify(tool)}`], cwd, timeoutMs);
  return fallback.ok;
}

async function runProbe(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    return { ok: true, output: `${stdout}\n${stderr}` };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string; code?: unknown };
    const output = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}\n${failure.message ?? ''}`.trim();
    // 127 is the shell's "command not found" code.
    if (failure.code === 127) return { ok: false, output: `${output}\ncommand not found` };
    return { ok: false, output };
  }
}
