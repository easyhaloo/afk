import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

assert.equal(process.argv.length, 4, 'Usage: node retrieval-ranking.mjs <repository> <archive-directory>');
const [repo, packageDir] = process.argv.slice(2).map(path => resolve(path));
const source = '6198fbbec9b4c4e0980b1c24d2abbaeab9046c19';
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
const sha = value => createHash('sha256').update(value).digest('hex');
const adrs = git('ls-tree', '-r', '--name-only', source, 'docs/adr').trim().split('\n')
  .filter(path => /\/\d{4}-/.test(path)).map(path => ({ origin: path, content: git('show', `${source}:${path}`).trim() }));
const sectionSources = [
  ['docs/architecture/execution.zh.md', '### 上下文交接'],
  ['docs/architecture/execution.zh.md', '### 执行基线与配置'],
  ['docs/architecture/execution.zh.md', '### PRD 基线分支'],
  ['docs/architecture/plugin-integration-standard.zh.md', '## 3. 能力接口与调用协议'],
  ['docs/architecture/plugin-integration-standard.zh.md', '### 8.1 候选独立验证协议'],
  ['docs/architecture/plugins.zh.md', '### 配置策略、验证闸门和 Agent 上下文指针'],
  ['docs/architecture/plugins.zh.md', '### 完整配置与定时调用示例'],
  ['docs/guides/testing.zh.md', '## 插件矩阵与源码覆盖率'],
  ['docs/guides/skills.zh.md', '### 需求与产品规划'],
  ['docs/guides/skills.zh.md', '### Agent 能力与推理治理'],
];
const excerpts = sectionSources.map(([path, heading]) => {
  const lines = git('show', `${source}:${path}`).split('\n');
  const index = lines.indexOf(heading);
  assert.ok(index >= 0, heading);
  const rank = heading.match(/^#+/)[0].length;
  const end = lines.findIndex((line, i) => i > index && new RegExp(`^#{1,${rank}} `).test(line));
  return { origin: `${path}#${heading.replace(/^#+ /, '')}`, content: lines.slice(index, end < 0 ? undefined : end).join('\n').trim() };
});
const docs = [...adrs, ...excerpts];
const queries = [
  ['How does afk doctor --fix reclaim a leaked dependency pool checkout?', '0038-workspace'],
  ['The JumpServer bastion rejected ssh -J. Which CLI reaches a host asset?', '0029-jumpserver'],
  ['Which fields must be redacted before storing evidence in logs or traces?', '0018-evidence'],
  ['Where should a PRD slice merge without bypassing human review?', '0024-prd'],
  ['How do runtime timer waits expose their reason to the scheduler?', '0027-scheduler'],
  ['How can I restore run continuity with an immutable run event audit spine?', '0016-run-event'],
  ['PRD 切片应合并到哪个基线分支？', '###2'],
  ['怎么用安装版做插件矩阵验证并测量源码覆盖率？', '###7'],
  ['怎样独立验证候选并保存断言证据？', '###4'],
  ['定时任务如何配置接收端和调用？', '###6'],
  ['如何将执行上下文交接给下一阶段？', '###0'],
  ['Agent 能力与推理治理由哪些技能支持？', '###9'],
  ['zxywnohit00013297', null],
];
const root = mkdtempSync(join(tmpdir(), 'w10-real-retrieval-'));
const env = { PATH: process.env.PATH, HOME: root, AFK_HOME: join(root, 'profile') };
const execute = (command, args) => execFileSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 30000 });
try {
  const archive = join(packageDir, `afk-${process.platform}-${process.arch}.tar.gz`);
  const cli = join(root, '.local', 'bin', 'afk');
  execute('bash', [join(packageDir, 'install.sh'), '--skip-completion', '--archive', archive, '--checksum', `${archive}.sha256`, '--version', '0.2.224']);
  assert.equal(execute(cli, ['--version']).trim(), '0.2.224');
  const config = join(root, 'retrieval.json');
  writeFileSync(config, JSON.stringify({ documents: docs }));
  execute(cli, ['plugin', 'configure', 'context.retrieval', '--builtin', '--file', config]);
  const input = join(root, 'query.json');
  let returnedFragments = 0;
  const results = queries.map(([prompt, target]) => {
    const expected = target === null ? null : (target.startsWith('###') ? excerpts[Number(target.slice(3))] : adrs.find(doc => doc.origin.includes(`/${target}`))).origin;
    writeFileSync(input, JSON.stringify({ scope: '.', prompt, limit: 5 }));
    const fragments = JSON.parse(execute(cli, ['plugin', 'invoke', 'context.provider', 'context.retrieval', 'gather', '--input', input, '--json']));
    assert.ok(fragments.length <= 5);
    returnedFragments += fragments.length;
    for (const { origin, content, score } of fragments) {
      assert.ok(Number.isSafeInteger(score) && score > 0);
      assert.equal(content, docs.find(doc => doc.origin === origin).content.slice(0, 20_000));
    }
    const rank = expected === null ? null : fragments.findIndex(fragment => fragment.origin === expected) + 1 || null;
    return { prompt, expected, rank, returned: fragments.map(({ origin, score }) => ({ origin, score })) };
  });
  assert.deepEqual(results.at(-1).returned, []);
  console.log(JSON.stringify({ sourceCommit: source, platform: `${process.platform}-${process.arch}`, version: '0.2.224',
    archiveSha256: sha(readFileSync(archive)), corpus: docs.map(({ origin, content }) => ({origin, sha256: sha(content)})),
    returnedFragments, top1: results.filter(r => r.rank === 1).length, top5: results.filter(r => r.rank).length, results }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
