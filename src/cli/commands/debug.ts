import { Command } from 'commander';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { handleCommandError, success, info, warning, fail, detail } from '../cli-utils';

export interface DebugState {
  original_command: string;
  last_command: string;
  last_output: string;
  last_exitcode: number;
  run_count: number;
  phase: string;
  hypotheses: string[];
  root_cause: string | null;
  fix_applied: string | null;
  verified: boolean;
}

const DEFAULT_STATE: DebugState = {
  original_command: '',
  last_command: '',
  last_output: '',
  last_exitcode: 0,
  run_count: 0,
  phase: '',
  hypotheses: [],
  root_cause: null,
  fix_applied: null,
  verified: false,
};

export function registerDebugCommands(program: Command): void {
  const debug = program
    .command('debug')
    .description('Reproduce → hypothesize → investigate → propose → verify loop');

  const debugDir = process.env.DEBUG_DIR ?? '.debug';
  const stateFile = join(debugDir, 'state.json');
  const commandsLog = join(debugDir, 'commands.log');

  // ── helpers ────────────────────────────────────────────────────────────────

  async function loadState(): Promise<DebugState> {
    try {
      const content = await fs.readFile(stateFile, 'utf-8');
      return JSON.parse(content);
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  async function saveState(state: DebugState): Promise<void> {
    await fs.mkdir(debugDir, { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf-8');
  }

  async function logCommand(cmd: string, output: string, exitcode: number): Promise<void> {
    await fs.mkdir(debugDir, { recursive: true });
    const entry = [
      `## ${new Date().toISOString()}`,
      `CMD: ${cmd}`,
      `EXIT: ${exitcode}`,
      '---',
      output,
      '',
    ].join('\n');
    const log = await fs.readFile(commandsLog, 'utf-8').catch(() => '');
    await fs.writeFile(commandsLog, log + entry, 'utf-8');
  }

  function requireState(state: DebugState): void {
    if (!state.phase) {
      handleCommandError(new Error('no debug session found. Run "afk debug reproduce <cmd>" first.'));
    }
  }

  function truncate(input: string, max = 10000): string {
    return input.slice(0, max);
  }

  // ── reproduce ─────────────────────────────────────────────────────────────

  debug
    .command('reproduce')
    .description('Execute and record a failing command')
    .argument('<cmd...>', 'Command to reproduce')
    .action(async (cmdParts: string[]) => {
      const cmd = cmdParts.join(' ');
      if (!cmd) {
        console.error('Usage: afk debug reproduce <command>');
        process.exit(1);
      }

      await fs.mkdir(debugDir, { recursive: true });

      // Preserve original command across re-runs
      const prev = await loadState();
      const originalCmd = prev.original_command || cmd;

      info(`Executing: ${cmd}`);
      const result = spawnSync(cmd, [], { encoding: 'utf-8', shell: true });
      const output = result.stdout + result.stderr;
      const exitcode = result.status ?? 1;

      const truncated = truncate(output, 10000);
      await logCommand(cmd, output, exitcode);

      const state: DebugState = {
        original_command: originalCmd,
        last_command: cmd,
        last_output: truncated,
        last_exitcode: exitcode,
        run_count: (prev.run_count || 0) + 1,
        phase: 'reproduced',
        hypotheses: [],
        root_cause: null,
        fix_applied: null,
        verified: false,
      };
      await saveState(state);

      console.log(`\nExit code: ${exitcode}`);
      console.log('Output:');
      console.log(output.slice(-50 * 80)); // last 50 lines

      if (exitcode === 0 && !output.trim()) {
        warning('Command succeeded with empty output — no error to diagnose.');
      }
    });

  // ── hypothesize ───────────────────────────────────────────────────────────

  debug
    .command('hypothesize')
    .description('List possible causes based on last output')
    .action(async () => {
      const state = await loadState();
      requireState(state);

      console.log('## Possible Hypotheses\n');
      console.log('Based on the last output and code analysis, list possible causes.\n');
      console.log('Last output (last 20 lines):');
      const lines = state.last_output.split('\n').slice(-20);
      lines.forEach(l => console.log(l));
      console.log('\nTo record hypotheses, manually update the state file or use propose.');
    });

  // ── investigate ──────────────────────────────────────────────────────────

  debug
    .command('investigate')
    .description('Read a file, optionally at a specific line')
    .argument('<file>', 'File to investigate')
    .argument('[line]', 'Line number to focus on', undefined)
    .action(async (file: string, lineStr: string | undefined) => {
      const state = await loadState();
      requireState(state);

      info(`Investigating: ${file}${lineStr ? ':' + lineStr : ''}`);

      try {
        const stat = await fs.stat(file);
        const allLines = (await fs.readFile(file, 'utf-8')).split('\n');
        console.log(`File: ${file} (${allLines.length} lines)`);

        if (lineStr) {
          const line = parseInt(lineStr, 10);
          if (isNaN(line) || line < 1 || line > allLines.length) {
            handleCommandError(new Error(`Invalid line number: ${lineStr}`));
          }
          const start = Math.max(1, line - 3);
          const end = Math.min(allLines.length, line + 3);
          console.log(`\nLines ${start}–${end} (focus: ${line}):`);
          for (let i = start - 1; i < end; i++) {
            const marker = i === line - 1 ? ' → ' : '    ';
            console.log(`${marker}${String(i + 1).padStart(4)} | ${allLines[i]}`);
          }
        }
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          handleCommandError(new Error(`File not found: ${file}`));
        } else {
          handleCommandError(err);
        }
      }
    });

  // ── propose ───────────────────────────────────────────────────────────────

  debug
    .command('propose')
    .description('Record a proposed fix description')
    .argument('<fix...>', 'Fix description')
    .action(async (fixParts: string[]) => {
      const state = await loadState();
      requireState(state);

      const fix = fixParts.join(' ');
      state.phase = 'fix_proposed';
      state.fix_applied = fix;
      await saveState(state);

      success(`Fix proposed: ${fix}`);
      console.log('\nAfter applying the fix, run:');
      console.log(`  afk debug verify "${state.original_command}"`);
    });

  // ── verify ────────────────────────────────────────────────────────────────

  debug
    .command('verify')
    .description('Re-run the original command to verify the fix')
    .argument('[cmd...]', 'Optional command override', undefined)
    .action(async (cmdParts: string[] | undefined) => {
      const state = await loadState();
      requireState(state);

      const cmd = cmdParts ? cmdParts.join(' ') : state.original_command;
      if (!cmd) {
        handleCommandError(new Error('no command to verify.'));
      }

      info(`Verifying: ${cmd}`);
      const result = spawnSync(cmd, [], { encoding: 'utf-8', shell: true });
      const output = result.stdout + result.stderr;
      const exitcode = result.status ?? 1;

      const truncated = truncate(output, 10000);
      const verified = exitcode === 0;
      state.last_command = cmd;
      state.last_output = truncated;
      state.last_exitcode = exitcode;
      state.verified = verified;
      await saveState(state);
      await logCommand(cmd, output, exitcode);

      if (verified) {
        success(`VERIFIED — exit ${exitcode}`);
        if (state.root_cause) detail(`Root cause: ${state.root_cause}`);
      } else {
        fail(`STILL FAILING — exit ${exitcode}`);
        console.log('Output:');
        console.log(output.slice(-30 * 80));
        console.log('\n→ Loop back: afk debug hypothesize');
      }
    });

  // ── status ────────────────────────────────────────────────────────────────

  debug
    .command('status')
    .description('Show current debug session state')
    .action(async () => {
      const state = await loadState();

      if (!state.phase) {
        warning('No active debug session. Run "afk debug reproduce <cmd>" to start.');
        return;
      }

      console.log('## Debug Session Status\n');
      console.log(`Original command: ${state.original_command}`);
      console.log(`Last command:     ${state.last_command}`);
      console.log(`Phase:           ${state.phase}`);
      console.log(`Run count:       ${state.run_count}`);
      console.log(`Verified:        ${state.verified}`);
      console.log(`Root cause:     ${state.root_cause ?? 'null'}`);
      console.log(`Fix applied:     ${state.fix_applied ?? 'null'}`);
      console.log('\n--- Last output (last 30 lines) ---');
      const lines = state.last_output.split('\n').slice(-30);
      lines.forEach(l => console.log(l));
    });

  // ── reset ────────────────────────────────────────────────────────────────

  debug
    .command('reset')
    .description('Clear the debug session and start over')
    .action(async () => {
      await fs.rm(debugDir, { recursive: true, force: true });
      success('Debug session reset.');
    });
}
