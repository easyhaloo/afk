import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { createExecutionWorkspaceService } from '../../../apps/desktop/electron/services/execution-workspace-service.js';
import { resolveE2eRuntime } from '../installed-runtime.js';
import { assertObservedRecall, recallCases } from './recall-v1.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const load = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const save = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2));
const cases = recallCases.filter(entry => /^skill-0[13456]$/.test(entry.id));
const execute = promisify(execFile);
type Part = { type: string; name?: string; text?: string; state?: { status: string; input: { id?: string; path?: string } } };
type Message = { type: string; outcome?: string; text?: string; finish?: string; content?: Part[] };

async function verifyGroup(ids: string[]) {
  const entries = ids.map(id => cases.find(entry => entry.id === id)!);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'w11-negative-')));
  const receiptRoot = mkdtempSync(join(realpathSync(process.env.AFK_W11_SKILL_RECEIPT!), ids.join('_') + '-'));
  console.info(ids, receiptRoot);
  const fixture = realpathSync(process.env.AFK_W11_SKILL_FIXTURE!);
  const host = realpathSync(process.env.AFK_E2E_OPENCODE_ENTRY!);
  const archive = realpathSync(process.env.AFK_W11_GUARD_TGZ!);
  const installation = resolveE2eRuntime(process.env.AFK_E2E_CLI_ENTRY);
  if (installation.mode !== 'installed') throw new Error('An installed AFK CLI is required');
  const history = load(join(fixture, 'historical.json'));
  const key = entries[0].asset.key;
  const staged = join(fixture, 'bundle/skills', key, 'SKILL.md');
  const sha256 = digest(staged);
  const extraction = load(join(fixture, 'extraction.json'));
  expect(extraction.candidates).toContainEqual(expect.objectContaining({ state: 'candidate', proposal: expect.objectContaining({ targetRef: `skill:${key}` }) }));
  expect(sha256).toBe('cc83fb84892ffc847dc7cbc73def65753f046882c03d73a27e9254435e1d5fc9');
  expect(history).toMatchObject({ key, scope: entries[0].asset.scope });
  const edition = history.revisions.indexOf(sha256) + 1;
  expect(edition).toBe(entries[0].asset.edition);
  const shared = { HOME: directory, XDG_CONFIG_HOME: join(directory, '.config'), XDG_CACHE_HOME: join(directory, 'cache'),
    XDG_DATA_HOME: join(directory, 'data'), XDG_STATE_HOME: join(directory, 'state'), PATH: `${dirname(process.env.AFK_E2E_OPENCODE_ENTRY!)}:${process.env.PATH}` };
  const install = (binary: string, args: string[]) => execFileSync(binary, args, { cwd: directory, env: shared, timeout: 90_000, encoding: 'utf8' });
  try {
    const prefix = join(directory, 'package');
    const npm = install('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', archive]);
    const pkg = join(prefix, 'node_modules/@easyhaloo/afk-opencode');
    const installer = join(pkg, 'skills/jev-agent-guard/scripts/install.mjs');
    const current = join(shared.XDG_DATA_HOME, 'jev-agent-guard/current');
    const plugins = join(shared.XDG_CONFIG_HOME, 'opencode/plugins');
    expect(existsSync(join(shared.XDG_CONFIG_HOME, 'opencode/skills/afk-do/SKILL.md'))).toBe(true);
    expect(existsSync(current)).toBe(false);
    const installLog = install(process.execPath, [installer, '--host=opencode']);
    const doctor = JSON.parse(install(process.execPath, [installer, 'doctor', '--host=opencode']));
    expect(doctor).toMatchObject({ runtime: { path: current, exists: true, sdk: true }, hosts: { opencode: { configured: true } } });
    const adapter = 'scripts/adapters/opencode-v2.mjs';
    expect(digest(join(current, adapter))).toBe(digest(join(root, 'skills/jev-agent-guard', adapter)));
    const shim = readFileSync(doctor.hosts.opencode.path, 'utf8');
    expect(shim).toContain('opencode-v2.mjs');
    const sessionsAtStartup = JSON.parse(install(host, ['session', 'list', '--format', 'json', '--standalone']));
    expect(sessionsAtStartup).toEqual([]);
    save(join(receiptRoot, 'install.json'), { archive, sha256: digest(archive), version: load(join(pkg, 'package.json')).version, npm, installLog, doctor, shim, sessionsAtStartup });
    for (const slot of ['aa-before', 'zy-after']) cpSync(join(root, 'tests/fixtures/w11/skill-negative-provider.mjs'), join(plugins, slot + '.js'));
    cpSync(join(root, 'tests/fixtures/w11/skill-negative-observer.mjs'), join(plugins, 'zz-w11-observer.js'));
    const state = entries[0].state;
    const manifest = join(shared.XDG_CONFIG_HOME, 'opencode/skills', entries[0].asset.key, 'SKILL.md');
    expect(existsSync(manifest)).toBe(false);
    let installedDigest: string | undefined;
    if (state !== 'proposal') {
      install(process.execPath, [join(fixture, 'bundle/postinstall.mjs')]);
      installedDigest = digest(manifest);
      if (state === 'uninstalled') rmSync(dirname(manifest), { recursive: true });
    }
    const tasks = [];
    for (const entry of entries) {
      const taskHome = join(directory, entry.id);
      vi.stubEnv('HOME', taskHome);
      const workspaces = createExecutionWorkspaceService({ baseDirectory: join(taskHome, 'tasks') });
      const taskId = `${entry.query.scope}#42` as const;
      const runId = `${entry.id}-${randomUUID()}`;
      const { root: workspace } = await workspaces.allocate(taskId);
      await workspaces.updateRun(taskId, runId);
      const receipt = join(receiptRoot, entry.id);
      mkdirSync(receipt);
      tasks.push({ taskHome, taskId, runId, workspace, receipt, entry });
    }
    vi.unstubAllEnvs();
    const sessions = await Promise.allSettled(tasks.map(async ({ taskHome, taskId, runId, workspace, receipt, entry }) => {
      const env = { ...shared, HOME: taskHome,
        AFK_LOG_DIR: join(receipt, 'logs'), AFK_OPENCODE_MODEL: 'opencode/big-pickle', OPENCODE_DISABLE_MODELS_FETCH: '1',
        W11_GUARD_RECEIPT: join(receipt, 'guard.jsonl'), OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: {
          '*': 'deny', skill: 'allow', read: 'allow', glob: 'allow', grep: 'allow', external_directory: 'deny' } }) };
      if (entry.state !== 'proposal') expect(installedDigest).toBe(sha256);
      const installedAtLaunch = existsSync(manifest);
      expect(installedAtLaunch).toBe(entry.state === 'active');
      save(join(receipt, 'installation.json'), { installation, host, hostVersion: execFileSync(host, ['--version'], { env, cwd: workspace, encoding: 'utf8' }).trim(),
        guardDigest: digest(join(current, 'scripts/adapters/opencode-v2.mjs')), guardVersion: load(join(root, '.claude-plugin/plugin.json')).version,
        fixture, sha256, installedDigest, installedAtLaunch, manifest, runId, workspace, taskId });
      const input = join(taskHome, 'input');
      mkdirSync(input);
      save(join(input, 'historical.json'), { query: entry.query });
      await execute(process.execPath, [join(root, 'tests/fixtures/w11/skill-01-consumer.mjs'), input, receipt, runId, installation.runtime], { cwd: workspace, env, timeout: 160_000 });
      const workflow = load(join(receipt, 'workflow.json'));
      const session = load(join(receipt, 'session.json'));
      expect(workflow).toMatchObject({ runId, workItemId: taskId, workspace, result: { success: true } });
      expect(workflow.events).toContainEqual(expect.objectContaining({ kind: 'agent.session_recorded', sessionId: session.info.id }));
      expect(session.info.location.directory).toBe(workspace);
      expect(session.info.tokens.output).toBeGreaterThan(0);
      const messages: Message[] = session.messages;
      expect(messages.at(-1)).toMatchObject({ type: 'idle', outcome: 'succeeded' });
      const assistant = messages.filter(message => message.type === 'assistant');
      expect(assistant.at(-1)).toMatchObject({ finish: 'stop', model: { id: 'big-pickle', providerID: 'opencode' } });
      const parts = assistant.flatMap(message => message.content ?? []);
      const answer = parts.filter(part => part.type === 'text').at(-1)?.text?.trim();
      expect(answer).toBeTruthy();
      const observations = readFileSync(env.W11_GUARD_RECEIPT, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      for (const event of observations) expect(event).toMatchObject({ session: session.info.id, cwd: workspace, task: { runId, taskId, workspace },
        trusted: { project: entry.query.scope, environment: entry.query.applicability?.environment, productVersions: entry.query.target?.productVersions } });
      const prompts = observations.filter(event => event.hook === 'prompt');
      expect(prompts).toHaveLength(1);
      expect(prompts[0].prompt).toBe(messages.find(message => message.type === 'user')?.text?.slice(0, 2000));
      expect(prompts[0].prompt).toContain(entry.query.prompt);
      const positive = entry.expected === 'hit';
      const contexts = observations.filter(event => event.hook === 'context');
      expect(contexts.length).toBeGreaterThan(0);
      const loaded = parts.filter(part => part.name === 'skill' && part.state?.status === 'completed');
      const body = readFileSync(staged, 'utf8').split('\n---\n')[1].trim().split('\n').filter(Boolean);
      const exposed = body.filter(line => JSON.stringify(parts).includes(line) || parts.some(part => part.text?.includes(line)));
      save(join(receipt, 'observation.json'), { caseId: entry.id, runId, session: session.info.id, query: entry.query, installedAtLaunch,
        decision: prompts[0].replay, catalogHasSkill: prompts[0].catalogHasSkill, catalogSize: prompts[0].catalogSize,
        loaded, exposed, answer, contexts: contexts.length, systemMentionsSkill: contexts.some(event => event.systemMentionsSkill) });
      expect(prompts[0].catalogSize).toBeGreaterThan(0);
      expect(prompts[0].catalogHasSkill).toBe(positive);
      for (const context of contexts) expect(context.catalog).toEqual(expect.arrayContaining(['aa-before', 'zy-after', 'aa-before-prompt', 'zy-after-prompt', 'afk-do']));
      expect(contexts.some(event => event.advice.includes(`Suggested Skill: ${key}`))).toBe(positive);
      if (positive) {
        for (const bag of [...workflow.oracle.missing, ...workflow.oracle.extra]) expect(answer).toContain(bag);
        expect(exposed.length).toBeGreaterThan(0);
      } else {
        expect(prompts[0].replay).toMatchObject({ decision: 'allow', reason: 'No relevant Skill was found.' });
        expect(contexts.every(event => !event.systemMentionsSkill && !event.catalog.includes(key))).toBe(true);
        expect(exposed).toEqual([]);
      }
      assertObservedRecall(entry, { caseId: entry.id, status: 'observed', ranked: loaded
        .filter(part => part.state?.input.id === key)
        .map(() => ({ scope: history.scope, key, edition })) });
      return { runId, workspace, session: session.info.id, busy: session.info.time.busy, idle: session.info.time.idle };
    }));
    const log = readFileSync(join(shared.XDG_DATA_HOME, 'opencode/log/opencode.log'), 'utf8');
    const orders = new Map<string, string[]>();
    for (const line of log.split('\n')) {
      const match = /run=(\S+).*msg="loading plugin" id=\S*\/plugins\/(aa-before|jev-agent-guard|zy-after|zz-w11-observer)\.js\s/.exec(line);
      if (!match) continue;
      const ordered = orders.get(match[1]) ?? [];
      ordered.push(match[2]);
      orders.set(match[1], ordered);
    }
    save(join(receiptRoot, 'plugins.json'), Object.fromEntries(orders));
    expect(orders.size).toBeGreaterThan(0);
    const observed = [...orders.values()].filter(order => order.includes('zz-w11-observer'));
    expect(observed.length).toBeGreaterThan(0);
    for (const order of observed) expect(order).toEqual(['aa-before', 'jev-agent-guard', 'zy-after', 'zz-w11-observer']);
    const times = sessions.map(session => { if (session.status === 'rejected') throw session.reason; return session.value; });
    if (times.length > 1) {
      const overlapMs = Math.min(...times.map(time => time.idle)) - Math.max(...times.map(time => time.busy));
      save(join(receiptRoot, 'concurrency.json'), { times, overlapMs, manifest, before: installedDigest, after: digest(manifest) });
      expect(digest(manifest)).toBe(installedDigest);
      expect(new Set(times.map(time => time.session)).size).toBe(times.length);
      expect(overlapMs).toBeGreaterThan(0);
    }
  } finally { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); }
}

it.runIf(process.env.AFK_W11_LIVE_SKILL_NEGATIVES === '1').each([
  { ids: ['skill-01', 'skill-03'] }, { ids: ['skill-04'] }, { ids: ['skill-05'] }, { ids: ['skill-06'] },
])('checks installed native sessions $ids', { timeout: 240_000, retry: 0 }, ({ ids }) => verifyGroup(ids));
