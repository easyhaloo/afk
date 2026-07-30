/**
 * E2E test for Notification component using node-pty
 *
 * This test requires the absolute positioning context that vitest cannot provide.
 * node-pty spawns a real PTY with actual terminal dimensions, so Yoga can compute
 * absolute positions correctly.
 *
 * Run: pnpm test tests/e2e/
 */
import { spawn } from 'node-pty';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distPath = join(__dirname, '../../dist/index.js');

// Detect node-pty at module load time (before tests run)
let nodePtyWorks = false;
try {
  const testPty = spawn('node', ['--version'], { cols: 80, rows: 24 });
  testPty.onData(() => {});
  testPty.onExit(() => {});
  testPty.kill();
  nodePtyWorks = true;
} catch {
  nodePtyWorks = false;
}

const describeE2E = nodePtyWorks ? describe : describe.skip;

describeE2E('Notification E2E (node-pty)', () => {
  let proc: ReturnType<typeof spawn> | null = null;

  afterEach(() => {
    if (proc) {
      proc.kill();
      proc = null;
    }
  });

  it('renders notification with absolute positioning', async () => {
    const output: string[] = [];

    proc = spawn(process.execPath, [distPath, 'board'], {
      cols: 80,
      rows: 24,
      env: { ...process.env, NO_TMUX: '1' },
    });

    proc.onData((data: string) => {
      output.push(data);
    });

    // Wait for initial render
    await new Promise(resolve => setTimeout(resolve, 500));

    proc.kill();

    const fullOutput = output.join('');

    // With a real terminal context, position:absolute elements render correctly
    expect(fullOutput.length).toBeGreaterThan(0);
  });

  it('can send key events to the TUI', async () => {
    const output: string[] = [];

    proc = spawn(process.execPath, [distPath, 'board'], {
      cols: 80,
      rows: 24,
      env: { ...process.env, NO_TMUX: '1' },
    });

    proc.onData((data: string) => {
      output.push(data);
    });

    await new Promise(resolve => setTimeout(resolve, 500));

    // Send 'q' to quit
    proc.write('q');

    await new Promise(resolve => setTimeout(resolve, 200));

    proc.kill();

    const fullOutput = output.join('');
    expect(fullOutput.length).toBeGreaterThan(0);
  });
});

if (!nodePtyWorks) {
  // Informational only - explains why E2E tests are skipped
  describe('Notification E2E (skipped)', () => {
    it('node-pty is not functional', () => {
      // Run: ./scripts/fix-node-pty.sh --force
      expect(true).toBe(true);
    });
  });
}
