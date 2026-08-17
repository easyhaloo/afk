/**
 * Real-terminal regression coverage for the read-only dashboard. Ink's Yoga
 * layout needs a PTY to calculate terminal dimensions and patch output.
 */
import { spawn } from 'node-pty';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stripVTControlCharacters } from 'node:util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repositoryRoot = join(__dirname, '../..');
const distPath = join(repositoryRoot, 'dist/cli/commands/board-entry.js');
const tsxPath = join(repositoryRoot, 'node_modules/tsx/dist/cli.mjs');
const fixturePath = join(__dirname, 'dashboard-layout.fixture.tsx');

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

function plainText(output: string): string {
  return stripVTControlCharacters(output).replace(/\[\d*[ABCDEFGHJKfmsu]/g, '');
}

function canSpawnPty(): boolean {
  try {
    const probe = spawn(process.execPath, ['--version'], { cols: 80, rows: 24 });
    probe.onData(() => {});
    probe.kill();
    return true;
  } catch {
    return false;
  }
}

class DashboardPty {
  private readonly output: string[] = [];
  private readonly proc: ReturnType<typeof spawn>;
  private readonly exited: Promise<void>;
  private exitCode: number | undefined;
  private exitSignal: number | undefined;

  constructor(command: string, args: string[], cols: number) {
    this.proc = spawn(command, args, {
      cols,
      rows: 30,
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NO_TMUX: '1',
        FORCE_COLOR: '0',
        ...(command === process.execPath && args[0] === distPath ? { AFK_SKIP_SPLASH: '1' } : {}),
      },
    });
    this.proc.onData(data => this.output.push(data));
    this.exited = new Promise(resolve => {
      this.proc.onExit(({ exitCode, signal }) => {
        this.exitCode = exitCode;
        this.exitSignal = signal;
        resolve();
      });
    });

    // node-pty starts with the requested dimensions, but Ink/Yoga can miss the
    // initial terminal-size event in CI. Emit an explicit resize after spawn so
    // the first render is patched while the process is still alive.
    try { this.proc.resize(cols, 30); } catch { /* process may have exited */ }
    setTimeout(() => {
      try { this.proc.resize(cols, 30); } catch { /* process may have exited */ }
    }, 100);
  }

  async waitFor(text: string, timeout = 6_000): Promise<string> {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const frame = plainText(this.output.join(''));
      if (frame.includes(text)) return frame;
      if (this.exitCode !== undefined || this.exitSignal !== undefined) {
        throw new Error(`Dashboard exited before ${JSON.stringify(text)} (code=${this.exitCode ?? 'null'}, signal=${this.exitSignal ?? 'null'}). Output: ${frame}`);
      }
      await delay(50);
    }
    throw new Error(`Timed out waiting for ${JSON.stringify(text)}. Output: ${plainText(this.output.join(''))}`);
  }

  async send(input: string, wait = 250): Promise<string> {
    const start = this.output.length;
    this.proc.write(input);
    await delay(wait);
    return plainText(this.output.slice(start).join(''));
  }

  async waitForExit(timeout = 2_000): Promise<void> {
    await Promise.race([
      this.exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for dashboard exit')), timeout)),
    ]);
  }

  stop(): void {
    this.proc.kill();
  }
}

const describePty = canSpawnPty() ? describe : describe.skip;

describePty('dashboard layout (node-pty)', () => {
  const processes: DashboardPty[] = [];

  afterEach(() => {
    for (const process of processes.splice(0)) process.stop();
  });

  function start(command: string, args: string[], cols: number): DashboardPty {
    const process = new DashboardPty(command, args, cols);
    processes.push(process);
    return process;
  }

  it.each([80, 100, 120, 160])('renders the production dashboard as one subview at %i columns', async cols => {
    const dashboard = start(process.execPath, [distPath], cols);
    const frame = await dashboard.waitFor('▸ AFK');

    expect(frame).toContain('1 tasks');
    expect(frame).toContain('2 backlogs');
    expect(frame).toContain('3 projects');
    expect(frame).toContain('4 board');
    expect(frame.toLowerCase()).not.toContain('preview');
  }, 12_000);

  it.each([80, 100, 120, 160])('renders a populated cockpit and queue at %i columns', async cols => {
    const dashboard = start(process.execPath, [tsxPath, fixturePath], cols);
    const frame = await dashboard.waitFor('recent activity');

    expect(frame).toContain('#17');
    expect(frame).toContain('#18');
    expect(frame).toContain('▶ #17');
    expect(frame).toContain('┆');
    expect(frame).toContain('edited ListView.tsx');
    expect(frame).not.toContain('+1 queued');
  }, 12_000);

  it('switches independent subviews and returns from a grouped detail screen', async () => {
    const dashboard = start(process.execPath, [tsxPath, fixturePath], 120);
    await dashboard.waitFor('Exercise responsive task navigation');

    const cockpit = await dashboard.waitFor('recent activity');
    expect(cockpit).toContain('processing');
    expect(cockpit).toContain('edited ListView.tsx');
    expect(cockpit).toContain('test');

    const backlogs = await dashboard.send('2');
    expect(backlogs).toContain('#42');
    expect(backlogs).not.toContain('fixture detail description');

    const detail = await dashboard.send('\r');
    expect(detail).toContain('identity');
    expect(detail).toContain('relationships');
    expect(detail).toContain('fixture detail description');
    expect(detail).not.toContain('preview');

    const list = await dashboard.send('b');
    expect(list).toContain('#42');
    expect(list).not.toContain('fixture detail description');

    const projects = await dashboard.send('3');
    expect(projects).toContain('AFK E2E fixture');
    expect(projects).toContain('AFK GitHub fixture');
    expect(projects).toContain('GH');

    const board = await dashboard.send('4');
    expect(board).toContain('flow');
    expect(board).toContain('Ready 1');
    expect(board).toContain('Processing 1');
    expect(board).toContain('Verification 1');
    expect(board).toContain('Attention 2');
    expect(board).toContain('Done 1');
    expect(board).toContain('◇');
    expect(board).toContain('#42');
    expect(board).not.toContain('preview');
  }, 12_000);

  it('moves the board focus across lanes with the right arrow', async () => {
    const dashboard = start(process.execPath, [tsxPath, fixturePath], 120);
    await dashboard.waitFor('Exercise responsive task navigation');
    await dashboard.send('4');

    const moved = await dashboard.send('\x1B[C', 350);
    expect(moved).toContain('▸ ▶ Processing 1');
    expect(moved).toContain('Prepare implementation branch');
  }, 12_000);

  it('exits globally with q from a detail subview', async () => {
    const dashboard = start(process.execPath, [tsxPath, fixturePath], 120);
    await dashboard.waitFor('Exercise responsive task navigation');
    await dashboard.waitFor('recent activity');
    await delay(300);
    await dashboard.send('\r', 500);
    await dashboard.waitFor('runtime', 8_000);

    await dashboard.send('q', 50);
    await dashboard.waitForExit();
  }, 12_000);

  it('opens debug mode only with ctrl+d', async () => {
    const dashboard = start(process.execPath, [tsxPath, fixturePath], 120);
    await dashboard.waitFor('Exercise responsive task navigation');

    const plainD = await dashboard.send('d', 350);
    expect(plainD).not.toContain('DEBUG LOG');

    const ctrlD = await dashboard.send('\x04', 350);
    expect(ctrlD).toContain('DEBUG LOG');
  }, 12_000);
});

if (!canSpawnPty()) {
  describe('dashboard layout (node-pty unavailable)', () => {
    it('skips real-terminal assertions when node-pty cannot start', () => {
      expect(true).toBe(true);
    });
  });
}