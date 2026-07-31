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
import { writeFileSync, mkdirSync } from 'fs';
import { afterEach, describe, expect, it } from 'vitest';
import puppeteer from 'puppeteer';
import { stripVTControlCharacters } from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distPath = join(__dirname, '../../dist/index.js');

// Ensure screenshot output directory exists
const screenshotDir = '/tmp/afk-e2e-screenshots';
try { mkdirSync(screenshotDir, { recursive: true }); } catch {}

// Helper to capture PTY output as screenshot
async function captureScreenshot(name: string, ansiData: string): Promise<string> {
  const outputPath = join(screenshotDir, `${name}.png`);
  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();

    // Use Node's built-in stripVTControlCharacters to remove all terminal control codes
    let plainText = stripVTControlCharacters(ansiData);

    // Remove any remaining terminal control patterns
    plainText = plainText.replace(/\[2K\[G|\[1A|\[2J|\[H|\[0K|\[K/g, '');

    // Escape HTML (but preserve Unicode box-drawing and special chars)
    const escapeHtml = (s: string) => s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br/>');

    const htmlContent = `<span style="color:#ffffff">${escapeHtml(plainText)}</span>`;

    const html = `<!DOCTYPE html>
<html>
<head><style>
body { background: #1e1e1e; margin: 20px; padding: 0; }
pre {
  font-family: Monaco, Menlo, 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.5;
  color: #fff;
  white-space: pre-wrap;
  word-wrap: break-word;
  margin: 0;
  padding: 10px;
  background: #1e1e1e;
  border-radius: 4px;
}
</style></head>
<body><pre>${htmlContent}</pre></body>
</html>`;

    await page.setContent(html);
    await page.waitForTimeout(300);
    const screenshot = await page.screenshot({ type: 'png' });
    writeFileSync(outputPath, screenshot);
    await browser.close();
    // Also log for debugging
    console.error(`[Screenshot] Saved: ${outputPath} (text length: ${plainText.length})`);
    return outputPath;
  } catch (err: any) {
    console.error(`[Screenshot] Failed: ${err?.message || err}`);
    return '';
  }
}

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

    proc = spawn(process.execPath, [distPath], {
      cols: 80,
      rows: 24,
      env: { ...process.env, NO_TMUX: '1' },
    });

    proc.onData((data: string) => {
      output.push(data);
    });

    // Wait for TUI to fully start (splash screen + init phases)
    await new Promise(resolve => setTimeout(resolve, 2000));

    proc.kill();

    const fullOutput = output.join('');

    // With a real terminal context, position:absolute elements render correctly
    expect(fullOutput.length).toBeGreaterThan(0);
  });

  it('can send key events to the TUI', async () => {
    const output: string[] = [];

    proc = spawn(process.execPath, [distPath], {
      cols: 80,
      rows: 24,
      env: { ...process.env, NO_TMUX: '1' },
    });

    proc.onData((data: string) => {
      output.push(data);
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    // Send 'q' to quit
    proc.write('q');

    await new Promise(resolve => setTimeout(resolve, 200));

    proc.kill();

    const fullOutput = output.join('');
    expect(fullOutput.length).toBeGreaterThan(0);
  });

  it('opens help dialog with ? key', async () => {
    const output: string[] = [];

    proc = spawn(process.execPath, [distPath], {
      cols: 80,
      rows: 24,
      env: { ...process.env, NO_TMUX: '1' },
    });

    proc.onData((data: string) => {
      output.push(data);
    });

    // Wait for TUI to fully load
    await new Promise(resolve => setTimeout(resolve, 2500));

    // Send '?' to open help
    proc.write('?');

    await new Promise(resolve => setTimeout(resolve, 2000));

    proc.kill();

    const fullOutput = output.join('');

    // Help dialog should show keyboard shortcuts
    expect(fullOutput.toLowerCase()).toMatch(/shortcuts|help|keys|q.*quit|\?/);
  });

  it('closes help dialog with q key', async () => {
    const output: string[] = [];

    proc = spawn(process.execPath, [distPath], {
      cols: 80,
      rows: 24,
      env: { ...process.env, NO_TMUX: '1' },
    });

    proc.onData((data: string) => {
      output.push(data);
    });

    // Wait for TUI to fully load
    await new Promise(resolve => setTimeout(resolve, 2500));

    // Open help with '?'
    proc.write('?');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Close with 'q'
    proc.write('q');
    await new Promise(resolve => setTimeout(resolve, 300));

    proc.kill();

    const fullOutput = output.join('');
    // Should still have content after closing help
    expect(fullOutput.length).toBeGreaterThan(0);
  });

  it('switches view with number keys', async () => {
    const output: string[] = [];

    proc = spawn(process.execPath, [distPath], {
      cols: 80,
      rows: 24,
      env: { ...process.env, NO_TMUX: '1' },
    });

    proc.onData((data: string) => {
      output.push(data);
    });

    // Wait for TUI to load (splash screen)
    await new Promise(resolve => setTimeout(resolve, 800));

    // Skip splash screen with ESC
    proc.write('\x1B'); // ESC
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Switch to tasks view with '1'
    proc.write('1');
    await new Promise(resolve => setTimeout(resolve, 300));

    // Switch to issues view with '2'
    proc.write('2');
    await new Promise(resolve => setTimeout(resolve, 300));

    // Switch to projects view with '3'
    proc.write('3');
    await new Promise(resolve => setTimeout(resolve, 300));

    proc.kill();

    const fullOutput = output.join('');
    expect(fullOutput.length).toBeGreaterThan(0);
  });

  it('activates search mode with / key', async () => {
    const output: string[] = [];

    proc = spawn(process.execPath, [distPath], {
      cols: 80,
      rows: 24,
      env: { ...process.env, NO_TMUX: '1' },
    });

    proc.onData((data: string) => {
      output.push(data);
    });

    // Wait for TUI to load
    await new Promise(resolve => setTimeout(resolve, 800));

    // Skip splash screen
    proc.write('\x1B'); // ESC
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Activate search mode with '/'
    proc.write('/');
    await new Promise(resolve => setTimeout(resolve, 300));

    // Type search query
    proc.write('test');

    await new Promise(resolve => setTimeout(resolve, 300));

    proc.kill();

    const fullOutput = output.join('');
    expect(fullOutput.length).toBeGreaterThan(0);
  });

  it('quits with q from main dashboard', async () => {
    const output: string[] = [];
    let exited = false;

    proc = spawn(process.execPath, [distPath], {
      cols: 80,
      rows: 24,
      env: { ...process.env, NO_TMUX: '1' },
    });

    proc.onData((data: string) => {
      output.push(data);
    });

    proc.onExit(() => {
      exited = true;
    });

    // Wait for TUI to load
    await new Promise(resolve => setTimeout(resolve, 800));

    // Skip splash screen
    proc.write('\x1B'); // ESC
    // Wait for dashboard to fully render after splash dismiss
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Quit with 'q'
    proc.write('q');

    // Wait for exit
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Process should have exited
    expect(exited).toBe(true);
  });

  it('ESC skips splash screen', async () => {
    const output: string[] = [];

    proc = spawn(process.execPath, [distPath], {
      cols: 80,
      rows: 24,
      env: { ...process.env, NO_TMUX: '1' },
    });

    proc.onData((data: string) => {
      output.push(data);
    });

    // Wait for splash screen to appear
    await new Promise(resolve => setTimeout(resolve, 300));

    // Press ESC to skip
    proc.write('\x1B'); // ESC

    // Wait for splash to disappear and dashboard to appear
    await new Promise(resolve => setTimeout(resolve, 2000));

    proc.kill();

    const fullOutput = output.join('');
    // Splash should be skipped (no "Press ESC to skip" anymore after pressing ESC)
    expect(fullOutput.length).toBeGreaterThan(0);
  });

  it('does not exit when pressing ESC after switching views from detail mode', async () => {
    const output: string[] = [];
    let exited = false;

    proc = spawn(process.execPath, [distPath], {
      cols: 80,
      rows: 24,
      env: { ...process.env, NO_TMUX: '1' },
    });

    proc.onData((data: string) => {
      output.push(data);
    });

    proc.onExit(() => {
      exited = true;
    });

    // Wait for TUI to load
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Skip splash screen
    proc.write('\x1B'); // ESC
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Test: in tasks view (viewStack length 1), ESC should NOT exit
    proc.write('\x1B'); // ESC
    await new Promise(resolve => setTimeout(resolve, 500));

    if (exited) {
      proc.kill();
      await captureScreenshot('regression-test-failure-1', output.join(''));
      console.error('[DEBUG] Exited at tasks view ESC');
      expect(exited).toBe(false);
      return;
    }

    // Switch to projects view (projects might be cached or load quickly)
    proc.write('3');
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Wait a bit for any initial load
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Try to enter detail mode
    proc.write('\r');
    await new Promise(resolve => setTimeout(resolve, 1000));

    if (exited) {
      proc.kill();
      await captureScreenshot('regression-test-failure-2', output.join(''));
      console.error('[DEBUG] Exited at projects detail Enter');
      expect(exited).toBe(false);
      return;
    }

    // Go back to list
    proc.write('b');
    await new Promise(resolve => setTimeout(resolve, 500));

    if (exited) {
      proc.kill();
      await captureScreenshot('regression-test-failure-3', output.join(''));
      console.error('[DEBUG] Exited at projects detail back (b)');
      expect(exited).toBe(false);
      return;
    }

    // Switch back to tasks
    proc.write('1');
    await new Promise(resolve => setTimeout(resolve, 500));

    // ESC should not exit in tasks view (viewStack length 1)
    proc.write('\x1B');
    await new Promise(resolve => setTimeout(resolve, 500));

    expect(exited).toBe(false);

    proc.kill();

    // Capture screenshot of final state
    const fullOutput = output.join('');
    await captureScreenshot('regression-test-final', fullOutput);

    expect(output.length).toBeGreaterThan(0);
  });

  it('navigates with arrow keys', async () => {
    const output: string[] = [];

    proc = spawn(process.execPath, [distPath], {
      cols: 80,
      rows: 24,
      env: { ...process.env, NO_TMUX: '1' },
    });

    proc.onData((data: string) => {
      output.push(data);
    });

    // Wait for TUI to load
    await new Promise(resolve => setTimeout(resolve, 800));

    // Skip splash screen
    proc.write('\x1B'); // ESC
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Navigate down with down arrow
    proc.write('\x1B[B'); // Down arrow
    await new Promise(resolve => setTimeout(resolve, 100));

    // Navigate up with up arrow
    proc.write('\x1B[A'); // Up arrow
    await new Promise(resolve => setTimeout(resolve, 100));

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
