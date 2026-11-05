/**
 * What an acceptance criterion's check command needs from the machine.
 *
 * A check command names the tools it runs. Knowing those tools before the
 * verification agent starts is what lets AFK say "pytest cannot even import
 * this suite here" instead of letting an agent discover it over an hour.
 *
 * This module only reads a command; it never runs one.
 */

/** A binary the check command invokes. */
export interface ToolRequirement {
  /** The binary name, as the command spells it. */
  tool: string;
  /** The acceptance criterion that needs it. */
  criterion: string;
  /** The command it was derived from. */
  checkCommand: string;
}

/**
 * Shell words that are not binaries: builtins, keywords and the words that
 * introduce another command. A check command that uses them needs no tool
 * from the machine beyond a shell.
 */
const NOT_A_TOOL: ReadonlySet<string> = new Set([
  '[', ']', '{', '}', '(', ')', 'if', 'then', 'else', 'elif', 'fi',
  'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function',
  'return', 'exit', 'echo', 'printf', 'cd', 'pwd', 'export', 'unset', 'set',
  'local', 'readonly', 'declare', 'shift', 'eval', 'exec', 'source', '.',
  'time', 'test', 'true', 'false', 'sudo', 'env', 'nohup', 'nice', 'ionice',
]);

/**
 * Words that only introduce the command that follows them. A negated check
 * (`! grep ...`) still runs grep.
 */
const SEGMENT_PREFIXES: ReadonlySet<string> = new Set(['!']);

/**
 * The binaries a check command invokes.
 *
 * The command is split at the places a shell runs one thing after another,
 * and the first word of each part is the binary. A leading `!` (a negated
 * check) and environment assignments (`FOO=bar cmd`) are skipped, because
 * neither is the thing that has to exist.
 */
export function requiredToolsForCommand(checkCommand: string): string[] {
  const tools: string[] = [];
  const seen = new Set<string>();
  for (const segment of splitCommand(checkCommand)) {
    for (const tool of binariesOf(segment)) {
      if (seen.has(tool)) continue;
      seen.add(tool);
      tools.push(tool);
    }
  }
  return tools;
}

/** The tools an acceptance criterion needs, one entry per binary. */
export function toolRequirements(criterion: string, checkCommand: string): ToolRequirement[] {
  return requiredToolsForCommand(checkCommand).map(tool => ({ tool, criterion, checkCommand }));
}

/**
 * Split a command where a shell runs one thing after another.
 *
 * A separator inside quotes is part of an argument, not a separator: the
 * alternation in `grep -cE 'a|b'` is one argument, and splitting there would
 * turn `b'` into what looks like a command.
 */
function splitCommand(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (const char of command) {
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '|' || char === ';' || char === '\n') {
      // `||` is one separator, and a single `|` is a pipeline.
      segments.push(current);
      current = '';
      continue;
    }
    if (char === '&') {
      segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments.map(part => part.trim()).filter(Boolean);
}

/**
 * The binaries one segment runs.
 *
 * A builtin like `test` does not end the search: its arguments may run
 * another command, as `test $(grep -c x f) -ge 1` does. A command
 * substitution is a command of its own, so the binary inside it is a tool the
 * check needs.
 */
function binariesOf(segment: string): string[] {
  const tools: string[] = [];
  const outer = firstBinaryOf(segment);
  if (outer) tools.push(outer);
  for (const substitution of commandSubstitutions(segment)) {
    for (const tool of requiredToolsForCommand(substitution)) {
      if (!tools.includes(tool)) tools.push(tool);
    }
  }
  return tools;
}

/**
 * The bodies of the command substitutions in a command.
 *
 * Both forms run another command: `$(...)` substitutes its output, and
 * `<(...)` substitutes a file descriptor. A binary inside either one has to
 * exist for the check to run.
 */
function commandSubstitutions(segment: string): string[] {
  const bodies: string[] = [];
  for (const opener of ['$(', '<(']) {
    let index = 0;
    while (index < segment.length) {
      const start = segment.indexOf(opener, index);
      if (start < 0) break;
      let depth = 1;
      let cursor = start + 2;
      while (cursor < segment.length && depth > 0) {
        if (segment[cursor] === '(') depth += 1;
        else if (segment[cursor] === ')') depth -= 1;
        cursor += 1;
      }
      if (depth === 0) bodies.push(segment.slice(start + 2, cursor - 1).trim());
      index = cursor;
    }
  }
  return bodies;
}

function firstBinaryOf(segment: string): string | undefined {
  const words = segment.split(/\s+/).filter(Boolean);
  for (const word of words) {
    if (word.includes('=') && !word.startsWith('-')) continue; // environment assignment
    if (word.startsWith('-')) continue; // a flag, not a binary
    const name = word.replace(/^["'`]|["'`]$/g, '');
    if (!name) continue;
    const lowered = name.toLowerCase();
    if (SEGMENT_PREFIXES.has(lowered)) continue;
    // A builtin ends the search: its arguments are not commands.
    if (NOT_A_TOOL.has(lowered)) return undefined;
    if (!/^[A-Za-z0-9_./-]+$/.test(name)) return undefined; // a variable or a subshell
    return name;
  }
  return undefined;
}

/**
 * The command a probe should run to find out whether a tool works here.
 *
 * `pytest --version` succeeds on a machine whose pytest cannot import the
 * suite it is asked to run, and `mvn` says nothing about the JDK it needs.
 * So the probe is the one that reproduces the failure the acceptance
 * criterion would hit.
 */
export function probeForTool(tool: string, checkCommand: string): { command: string; args: string[] } {
  switch (tool) {
    case 'pytest':
      return { command: 'python3', args: ['-m', 'pytest', '--collect-only', '-q', ...pytestTargets(checkCommand)] };
    case 'mvn':
      return { command: 'mvn', args: ['-v'] };
    case 'gradle':
      return { command: 'gradle', args: ['-v'] };
    case 'node':
      return { command: 'node', args: ['-v'] };
    case 'npm':
    case 'pnpm':
    case 'yarn':
      return { command: tool, args: ['-v'] };
    case 'go':
      return { command: 'go', args: ['version'] };
    case 'cargo':
      return { command: 'cargo', args: ['--version'] };
    case 'python':
    case 'python3':
      return { command: tool, args: ['--version'] };
    case 'java':
      return { command: 'java', args: ['-version'] };
    case 'curl':
      return { command: 'curl', args: ['--version'] };
    case 'jq':
      return { command: 'jq', args: ['--version'] };
    case 'docker':
      return { command: 'docker', args: ['version'] };
    case 'git':
      return { command: 'git', args: ['--version'] };
    default:
      return { command: tool, args: ['--version'] };
  }
}

/**
 * The test files a pytest command names.
 *
 * Only paths that look like test files are collected: probing the whole
 * repository would run the agent's work by accident.
 */
function pytestTargets(checkCommand: string): string[] {
  const targets: string[] = [];
  for (const word of checkCommand.split(/\s+/)) {
    const cleaned = word.replace(/^["'`]|["'`]$/g, '');
    if (!cleaned) continue;
    if (/^-/.test(cleaned)) continue;
    if (!/\.(py|pyi)$/.test(cleaned)) continue;
    if (!cleaned.includes('/') && !cleaned.startsWith('.')) continue;
    targets.push(cleaned);
  }
  return targets;
}
