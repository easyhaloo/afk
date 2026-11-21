import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

for (const entry of ['postinstall', 'setup']) {
  test(`${entry} refreshes equal-length skill and resource edits and preserves identical files`, context => {
    const root = mkdtempSync(join(tmpdir(), 'afk-skill-content-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const bundle = join(root, 'bundle');
    const skill = join(bundle, 'skills', 'inventory');
    mkdirSync(join(skill, 'references'), { recursive: true });
    for (const file of ['plugin.mjs', 'postinstall.mjs', 'install-skills.mjs']) {
      copyFileSync(new URL(file, import.meta.url), join(bundle, file));
    }
    const config = join(root, 'config');
    const target = join(config, 'opencode', 'skills', 'inventory');
    const install = () => execFileSync(process.execPath, entry === 'setup'
      ? ['--input-type=module', '-e', "import plugin from './plugin.mjs'; await plugin.setup({});"]
      : ['postinstall.mjs'], { cwd: bundle, env: { HOME: root, XDG_CONFIG_HOME: config } });
    const body = '---\nname: inventory\ndescription: Count items\n---\nPick low.\n';
    const resource = 'references/count.txt';
    writeFileSync(join(skill, 'SKILL.md'), body);
    writeFileSync(join(skill, resource), '11\n');
    install();
    for (const [path, expected] of [[resource, '29\n'], ['SKILL.md', body.replace('low', 'max')], ['SKILL.md', body], [resource, '11\n']]) {
      const installed = join(target, path);
      assert.notEqual(readFileSync(installed, 'utf8'), expected);
      writeFileSync(join(skill, path), expected);
      install();
      assert.equal(readFileSync(installed, 'utf8'), expected);
    }
    const manifest = join(target, 'SKILL.md');
    utimesSync(manifest, 1000000000, 1000000000);
    install();
    assert.equal(statSync(manifest).mtimeMs, 1000000000000);
  });
}
