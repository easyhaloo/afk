import { spawn } from 'node-pty';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { stripVTControlCharacters } from 'util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = join(__dirname, '../../dist/index.js');
const require = createRequire(import.meta.url);

let nodePtyWorks = false;
try {
  const probe = spawn(process.execPath, ['--version'], { cols: 80, rows: 24 });
  probe.onData(() => {});
  probe.onExit(() => {});
  probe.kill();
  nodePtyWorks = true;
} catch {
  nodePtyWorks = false;
}

const describeE2E = nodePtyWorks ? describe : describe.skip;

describeE2E('external TUI plugins', () => {
  let processHandle: ReturnType<typeof spawn> | null = null;
  let pluginHome: string | null = null;

  afterEach(() => {
    processHandle?.kill();
    processHandle = null;
    if (pluginHome) rmSync(pluginHome, { recursive: true, force: true });
    pluginHome = null;
  });

  it('loads an enabled plugin and switches to its page by shortcut', async () => {
    if (!existsSync(distPath)) return;

    const reactUrl = pathToFileURL(require.resolve('react')).href;
    const inkUrl = pathToFileURL(require.resolve('ink')).href;
    pluginHome = mkdtempSync(join(tmpdir(), 'afk-plugin-e2e-'));
    const pluginDir = join(pluginHome, '.afk', 'plugins', 'example', 'dist');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginHome, '.afk', 'plugins.yml'), 'plugins:\n  - id: example\n    enabled: true\n');
    writeFileSync(join(pluginDir, 'index.js'), `
      import React from ${JSON.stringify(reactUrl)};
      import { Text } from ${JSON.stringify(inkUrl)};
      export default {
        id: 'example',
        name: 'Example',
        views: [{
          id: 'status',
          title: 'Status',
          shortcut: 'z',
          render: context => React.createElement(Text, null, 'EXTERNAL PLUGIN ACTIVE ' + context.cwd),
        }],
      };
    `);

    const output: string[] = [];
    processHandle = spawn(process.execPath, [distPath], {
      cols: 100,
      rows: 30,
      env: { ...process.env, HOME: pluginHome, NO_TMUX: '1', AFK_SKIP_SPLASH: '1' },
    });
    processHandle.onData(data => output.push(data));

    await new Promise(resolve => setTimeout(resolve, 1800));
    processHandle.write('z');
    await new Promise(resolve => setTimeout(resolve, 500));
    const text = stripVTControlCharacters(output.join(''));
    processHandle.write('q');

    expect(text).toContain('EXTERNAL PLUGIN ACTIVE');
  });
});
