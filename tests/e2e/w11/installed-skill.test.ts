import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { createExecutionWorkspaceService } from '../../../apps/desktop/electron/services/execution-workspace-service.js';
import { prepareAssetProposal } from '../../../packages/runtime/src/application/learning/proposals.js';
import { resolveExperienceQueryContext } from '../../../packages/runtime/src/application/learning/runtime.js';
import { assertObservedRecall, recallCases } from './recall-v1.js';
import { resolveE2eRuntime } from '../installed-runtime.js';

const host = process.env.AFK_E2E_OPENCODE_ENTRY;
const root = fileURLToPath(new URL('../../../', import.meta.url));
const key = 'reconcile-bags';
const description = '封袋对账（袋单核对）技能比对交接单和袋号，只读输出差异。';
const sourceScope = { project: 'github:w11/parcel', productVersions: { parcel: '2.0' }, environment: 'staging' };
const digest = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');

function prepareFixture(directory: string) {
  const source = join(directory, 'source', key, 'SKILL.md');
  const original = ['---', `name: ${key}`, `description: ${description}`, 'allowed-tools: [Read]', 'disallowed-tools: [Bash, Write]',
    `afk-recall: ${JSON.stringify(sourceScope)}`, '---', '按照袋号核对交接单，报告差异。', ''].join('\n');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, original);
  const prepared = prepareAssetProposal({ kind: 'skill', title: '封袋对账', statement: description, evidenceIds: ['fixture-handoff'],
    targetRef: `skill:${key}`, applicability: { project: 'github:w11/parcel', environments: ['staging'], versions: ['2.0'],
      preconditions: [], exclusions: [], invalidationConditions: [] }, payload: { targetSkill: `skill:${key}`, originalDigest: digest(original),
      triggers: ['封袋对账', '袋单核对'], prohibitedConditions: ['无权读取交接单'], inputs: [{ name: 'manifest', description: '交接单', required: true }],
      branches: ['记录每个袋号的差异'], recovery: ['交接单不完整时请求补齐'], completion: '报告已核对的差异', patch: '只读对账并报告缺失袋号',
      evaluationCases: [{ kind: 'normal', input: '一件漏登', expected: '列出漏登袋号' }, { kind: 'recovery', input: '清单缺页', expected: '请求补齐' },
        { kind: 'refusal', input: '无读取权限', expected: '拒绝读取' }] } }, { skills: [{ name: key, description,
      'disable-model-invocation': false, 'user-invocable': true, 'allowed-tools': ['Read'], 'disallowed-tools': ['Bash', 'Write'],
      source: { root: dirname(dirname(source)), file: source } }],
    tools: [], toolSearches: ['cli', 'script', 'plugin'] });
  expect(prepared.execution.autoInstall).toBe(false);
  expect(prepared.proposal.applicability).toMatchObject({ project: sourceScope.project, versions: Object.values(sourceScope.productVersions),
    environments: [sourceScope.environment] });
  expect(prepared.invocation).toMatchObject({ automatic: true, allowedTools: ['Read'], disallowedTools: ['Bash', 'Write'] });
  const bundle = join(directory, 'bundle');
  const staged = join(bundle, 'skills', key, 'SKILL.md');
  mkdirSync(dirname(staged), { recursive: true });
  writeFileSync(staged, prepared.artifact.content);
  for (const script of ['install-skills.mjs', 'postinstall.mjs']) cpSync(join(root, '.opencode-pkg', script), join(bundle, script));
  const revisions = [digest(readFileSync(source)), digest(readFileSync(staged))];
  expect(revisions).toEqual([prepared.artifact.originalDigest, prepared.artifact.digest]);
  expect(new Set(revisions).size).toBe(2);
  return { bundle, revisions, scope: prepared.proposal.applicability.project };
}

it.runIf(process.env.AFK_W11_SKILL_FIXTURE)('reconstructs the historical skill-01 installation bytes', () => {
  const directory = realpathSync(process.env.AFK_W11_SKILL_FIXTURE!);
  const fixture = prepareFixture(directory);
  expect(fixture.revisions[1]).toBe('cc83fb84892ffc847dc7cbc73def65753f046882c03d73a27e9254435e1d5fc9');
  const entry = recallCases.find(row => row.id === 'skill-01')!;
  writeFileSync(join(directory, 'historical.json'), JSON.stringify({ ...fixture, query: entry.query, key }, null, 2));
});

function scoreManagedReceipt(receipt: string, fixture: string) {
  const load = (name: string) => JSON.parse(readFileSync(join(receipt, `${name}.json`), 'utf8'));
  const workflow = load('workflow');
  const session = load('session');
  const install = load('installation');
  const entry = recallCases.find(row => row.id === 'skill-01')!;
  const history = JSON.parse(readFileSync(join(fixture, 'historical.json'), 'utf8'));
  expect(history.query).toEqual(entry.query);
  expect(workflow).toMatchObject({ runId: install.runId, workItemId: `${entry.query.scope}#42`, result: { success: true } });
  expect(workflow.events).toContainEqual(expect.objectContaining({ kind: 'agent.session_recorded', sessionId: session.info.id }));
  expect(session.info.location.directory).toBe(install.workspace);
  expect(session.info.tokens.output).toBeGreaterThan(0);
  expect(install.sha256).toBe('cc83fb84892ffc847dc7cbc73def65753f046882c03d73a27e9254435e1d5fc9');
  const bytes = readFileSync(join(fixture, 'bundle/skills', key, 'SKILL.md'));
  expect(digest(bytes)).toBe(install.sha256);
  type Part = { type: string; name?: string; text?: string; state?: { status: string; input: { id: string }; metadata: { directory: string }; content: { text: string }[] } };
  const parts: Part[] = session.messages.filter((message: { type: string }) => message.type === 'assistant').flatMap((message: { content: Part[] }) => message.content);
  const loaded = parts.filter(part => part.type === 'tool' && part.name === 'skill' && part.state?.status === 'completed').map(part => {
    const { input, metadata, content } = part.state!;
    expect(metadata.directory).toBe(dirname(install.installed));
    const returned = JSON.parse(content[0].text) as { text: string }[];
    expect(returned[0].text).toContain(bytes.toString().split('\n---\n')[1].trim());
    return input.id;
  });
  assertObservedRecall(entry, { caseId: entry.id, status: 'observed', ranked: loaded.map(selected => ({ scope: entry.query.scope,
    key: selected, edition: history.revisions.indexOf(install.sha256) + 1 })) });
  const answer = parts.filter(part => part.type === 'text').at(-1)?.text ?? '';
  const { manifest, scanned } = workflow.input as { manifest: string[]; scanned: string[] };
  const missing = manifest.filter(bag => !scanned.includes(bag));
  const extra = scanned.filter(bag => !manifest.includes(bag));
  for (const [bags, label] of [[missing, /缺失|漏扫|未扫描|missing/i], [extra, /多出|多余|多扫|额外|交接单未列|extra/i]] as const) {
    for (const bag of bags) expect(answer.split('\n').some(line => line.includes(bag) && label.test(line) &&
      [...missing, ...extra].every(other => other === bag || !line.includes(other)))).toBe(true);
  }
  const guard = readFileSync(join(receipt, 'guard.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(guard).toContainEqual(expect.objectContaining({ task: expect.objectContaining({ workspace: install.workspace, taskId: workflow.workItemId,
    runId: workflow.runId, applicability: entry.query.applicability, target: { project: entry.query.scope, productVersions: entry.query.target!.productVersions } }),
    advice: [`Suggested Skill: ${key}`] }));
  writeFileSync(join(receipt, 'scored.json'), JSON.stringify({ session: session.info.id, run: workflow.runId, loaded, sha256: install.sha256, missing, extra, answer }, null, 2));
}

it.runIf(process.env.AFK_W11_SKILL_REPLAY)('rescores the managed skill-01 native session without an agent', () => {
  scoreManagedReceipt(process.env.AFK_W11_SKILL_REPLAY!, process.env.AFK_W11_SKILL_FIXTURE!);
});

it.runIf(process.env.AFK_W11_LIVE_SKILL01 === '1')('uses the historical skill in a managed work item', { timeout: 180_000, retry: 0 }, async () => {
  const installation = resolveE2eRuntime(process.env.AFK_E2E_CLI_ENTRY);
  if (installation.mode !== 'installed') throw new Error('Installed CLI required');
  const receipt = realpathSync(process.env.AFK_W11_SKILL_RECEIPT!);
  const fixture = realpathSync(process.env.AFK_W11_SKILL_FIXTURE!);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'w11-managed-skill-')));
  const entry = recallCases.find(row => row.id === 'skill-01')!;
  const history = JSON.parse(readFileSync(join(fixture, 'historical.json'), 'utf8'));
  expect(history.query).toEqual(entry.query);
  const runId = `skill-consumer-${randomUUID()}`;
  try {
    vi.stubEnv('HOME', directory);
    const workspaces = createExecutionWorkspaceService({ baseDirectory: join(directory, 'tasks') });
    const taskId = `${entry.query.scope}#42`;
    const { root: workspace } = await workspaces.allocate(taskId);
    await workspaces.updateRun(taskId, runId);
    const env = { HOME: directory, XDG_CONFIG_HOME: join(directory, '.config'), XDG_CACHE_HOME: join(directory, 'cache'),
      XDG_DATA_HOME: join(directory, 'data'), XDG_STATE_HOME: join(directory, 'state'), PATH: `${dirname(host!)}:${process.env.PATH}`,
      AFK_LOG_DIR: join(receipt, 'runtime-logs'), AFK_OPENCODE_MODEL: process.env.AFK_OPENCODE_MODEL!, OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { '*': 'deny', skill: 'allow', read: 'allow', glob: 'allow', grep: 'allow', external_directory: 'deny' } }) };
    const run = (script: string, args: string[]) => execFileSync(process.execPath, [script, ...args], { cwd: workspace, env, encoding: 'utf8', timeout: 160_000 });
    const guard = join(root, 'skills/jev-agent-guard');
    run(join(guard, 'scripts/install.mjs'), ['--host=opencode', '--skip-sdk']);
    writeFileSync(join(env.XDG_CONFIG_HOME, 'opencode/plugins/zz-w11-observe.js'), `import { appendFileSync } from 'node:fs';
export default { id: 'w11-observe', async setup(ctx) {
  await ctx.session.hook('context', event => {
    const advice = event.system.filter(part => part.text?.startsWith('Suggested Skill: ')).map(part => part.text);
    appendFileSync(${JSON.stringify(join(receipt, 'guard.jsonl'))}, JSON.stringify({ task: JSON.parse(process.env.AFK_SKILL_TASK_CONTEXT || 'null'), advice }) + '\\n');
  });
} };`);
    cpSync(join(guard, 'node_modules'), join(env.XDG_DATA_HOME, 'jev-agent-guard/current/node_modules'), { recursive: true, dereference: true });
    run(join(fixture, 'bundle/postinstall.mjs'), []);
    const installed = join(env.XDG_CONFIG_HOME, 'opencode/skills', key, 'SKILL.md');
    const sha256 = digest(readFileSync(installed));
    expect(sha256).toBe('cc83fb84892ffc847dc7cbc73def65753f046882c03d73a27e9254435e1d5fc9');
    writeFileSync(join(receipt, 'installation.json'), JSON.stringify({ installed, sha256, workspace, runId, taskId, model: env.AFK_OPENCODE_MODEL, installation }));
    run(join(root, 'tests/fixtures/w11/skill-01-consumer.mjs'), [fixture, receipt, runId, installation.runtime]);
    scoreManagedReceipt(receipt, fixture);
  } finally { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); }
});

it.skipIf(!host || process.platform !== 'darwin').each(recallCases.filter(entry => entry.kind === 'skill'))(
  'scores local file installation via the OpenCode prompt adapter for $id', async entry => {
    const caseId = entry.id;
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'w11-opencode-')));
    try {
      const fixture = prepareFixture(directory);
      vi.stubEnv('HOME', directory);
      const workspaces = createExecutionWorkspaceService({ baseDirectory: join(directory, 'tasks') });
      const env = { HOME: directory, XDG_CONFIG_HOME: join(directory, '.config'), XDG_CACHE_HOME: join(directory, 'cache'),
        XDG_DATA_HOME: join(directory, 'data'), XDG_STATE_HOME: join(directory, 'state'), PATH: `${dirname(host!)}:${process.env.PATH}`,
        OPENCODE_DISABLE_MODELS_FETCH: '1' };
      const offline = (binary: string, args: string[], cwd = directory, input?: string, taskEnv = {}) => execFileSync('/usr/bin/sandbox-exec', ['-p',
        '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote unix-socket)(remote ip "localhost:*"))',
        binary, ...args], { cwd, env: { ...env, ...taskEnv }, input, encoding: 'utf8', timeout: 15_000 });
      const guard = join(root, 'skills/jev-agent-guard');
      const runtime = join(env.XDG_DATA_HOME, 'jev-agent-guard', 'current');
      expect(offline(process.execPath, [join(guard, 'scripts/install.mjs'), '--host=opencode', '--skip-sdk'])).toContain(runtime);
      cpSync(join(guard, 'node_modules'), join(runtime, 'node_modules'), { recursive: true, dereference: true });
      const adapter = join(runtime, 'scripts/adapters/opencode.mjs');
      const installedRoot = join(env.XDG_CONFIG_HOME, 'opencode', 'skills');
      const manifest = join(installedRoot, key, 'SKILL.md');
      expect(existsSync(manifest)).toBe(false);
      if (entry.state !== 'proposal') {
        const output = offline(process.execPath, [join(fixture.bundle, 'postinstall.mjs')]);
        expect(output).toContain('installed');
        expect(digest(readFileSync(manifest))).toBe(fixture.revisions[1]);
      }
      const observe = async (query: typeof entry.query, runId: string) => {
        const taskId = `${query.scope}#42`;
        const { root: cwd } = await workspaces.allocate(taskId);
        await workspaces.updateRun(taskId, runId);
        const context = await resolveExperienceQueryContext({ workItemId: taskId, worktreePath: cwd, target: query.target,
          applicability: query.applicability });
        const task = { workspace: cwd, taskId, runId, ...context };
        const taskEnv = { AFK_SKILL_TASK_CONTEXT: JSON.stringify(task) };
        const { data: session } = JSON.parse(offline(host!, ['api', '--standalone', 'session.create', '--data', '{}'], cwd, undefined, taskEnv));
        expect(session.location.directory).toBe(cwd);
        expect(session.id).toMatch(/^ses_/);
        expect(session.tokens).toMatchObject({ input: 0, output: 0 });
        const decision = JSON.parse(offline(process.execPath, [adapter, 'prompt'], cwd, JSON.stringify({ prompt: query.prompt,
          cwd, session_id: session.id }), taskEnv));
        expect(decision).toMatchObject({ schema_version: 1, host: 'opencode', event: 'prompt' });
        const ranked = [];
        if (decision.decision === 'advise') {
          const match = /^Suggested Skill: ([a-z0-9-]+)$/.exec(decision.nextStep);
          if (!match) throw new Error(`Unmapped adapter output: ${decision.nextStep}`);
          const file = realpathSync(join(installedRoot, match[1], 'SKILL.md'));
          expect(file).toBe(manifest);
          const bytes = readFileSync(file);
          expect(bytes.toString()).toContain(`\nname: ${match[1]}\n`);
          const edition = fixture.revisions.indexOf(digest(bytes)) + 1;
          expect(edition).toBeGreaterThan(0);
          ranked.push({ scope: fixture.scope, key: match[1], edition });
        } else {
          expect(decision).toMatchObject({ decision: 'allow', reason: 'No relevant Skill was found.' });
          expect(decision.nextStep).toBeUndefined();
        }
        return { session: session.id, task, decision, ranked };
      };
      let before;
      if (caseId === 'skill-03' || caseId === 'skill-04' || entry.state === 'uninstalled') {
        const control = recallCases.find(row => row.id === 'skill-01')!;
        expect(control.query.prompt).toBe(entry.query.prompt);
        before = await observe(control.query, 'control-run');
        assertObservedRecall(control, { caseId: control.id, status: 'observed', ranked: before.ranked });
        expect(before.ranked).toHaveLength(1);
        if (entry.state === 'uninstalled') rmSync(dirname(manifest), { recursive: true });
      }
      const observed = await observe(entry.query, 'case-run');
      expect(observed.session).not.toBe(before?.session);
      if (existsSync(manifest)) expect(digest(readFileSync(manifest))).toBe(fixture.revisions[1]);
      console.info(JSON.stringify({ caseId, boundary: 'local-file / installed OpenCode guard prompt adapter', host: offline(host!, ['--version']).trim(),
        hostEntry: host, adapter, pluginVersion: JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8')).version,
        artifactSha256: fixture.revisions[1], installed: existsSync(manifest), before, observed }));
      assertObservedRecall(entry, { caseId, status: 'observed', ranked: observed.ranked });
    } finally { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); }
  });
