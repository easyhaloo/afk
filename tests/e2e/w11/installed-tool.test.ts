import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { ContextFragment, ContextQuery } from '@afk/runtime/plugin-sdk';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assertObservedRecall, recallCases } from './recall-v1.js';
import { driver } from './managed-fact.js';

const execute = promisify(execFile);
const installed = process.env.AFK_W11_CONSUMER_CLI_ENTRY ?? process.env.AFK_E2E_CLI_ENTRY;
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const discovery = join(repo, 'packages/runtime/src/application/plugins/tool-assets/discovery');
const catalog = 'context.installed-tools';
const plugin = 'tool.scan-manifest';
const source = { project: 'github:w11/parcel', productVersions: { parcel: '2.0' }, environment: 'staging', names: ['清单验码', '面单校验'],
  description: '清单验码（面单校验）工具只读检查扫描清单的校验位。' };
const toolPackage = join(dirname(discovery), 'scan-manifest');
const sourceBytes = JSON.stringify(source) + '\n';
const digest = createHash('sha256').update(sourceBytes).digest('hex');
const manifest = { id: plugin, version: '2.0.2', apiVersion: 1, trusted: true, concurrentVerification: true, provides: ['verification.provider'], entry: 'index.mjs', sourceDigest: digest };
type Route = { capability: string; provider: string; operation: string };
type Receipt = { id: string; version: string; entry: string; integrity: string; treeIntegrity: string; installedAt: string; source: string; manifest: typeof manifest };

function sharedGrant(receipt: Receipt, project: string, workspace: string) {
  const { id: plugin, version, entry, integrity, treeIntegrity } = receipt;
  return { project, workspace, plugin, version, entry, integrity, treeIntegrity };
}

let artifact: string;
let packDirectory: string | undefined;
beforeAll(async () => {
  if (!installed) return;
  if (process.env.W11_TOOL_DISCOVERY_TGZ) {
    artifact = resolve(process.env.W11_TOOL_DISCOVERY_TGZ);
  } else {
    packDirectory = await fs.mkdtemp(join(tmpdir(), 'tool-delivery-'));
    const { stdout } = await execute('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', packDirectory], { cwd: discovery });
    artifact = join(packDirectory, JSON.parse(stdout)[0].filename);
  }
  console.log(JSON.stringify({ artifact, sha256: createHash('sha256').update(await fs.readFile(artifact)).digest('hex') }));
});
afterAll(async () => { if (packDirectory) await fs.rm(packDirectory, { recursive: true, force: true }); });

type Profile = { cli: (...args: string[]) => Promise<string>; home: string; runtime: string; cliVersion: string; env: NodeJS.ProcessEnv; workspace: string };
async function withProfile(name: string, test: (profile: Profile) => Promise<void>) {
  const binary = await fs.realpath(installed!);
  const release = dirname(dirname(binary));
  expect(binary.startsWith(await fs.realpath(repo) + sep)).toBe(false);
  expect(binary).toBe(join(release, 'dist/index.js'));
  const runtime = await fs.realpath(join(release, 'node_modules/@afk/runtime/dist'));
  expect(runtime.startsWith(release + sep)).toBe(true);
  const cliVersion = JSON.parse(await fs.readFile(join(release, 'release.json'), 'utf8')).version;
  const expectedVersion = process.env.AFK_W11_CONSUMER_CLI_ENTRY && process.env.AFK_W11_CONSUMER_CLI_VERSION;
  expect(cliVersion).toBe(expectedVersion || JSON.parse(await fs.readFile(join(repo, 'apps/cli/package.json'), 'utf8')).version);
  const home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), `w11-${name}-`)));
  let workspace: string | undefined;
  try {
    const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), PATH: process.env.PATH, NO_COLOR: '1', npm_config_offline: 'true' };
    const cli = async (...args: string[]) => (await execute(process.execPath, [binary, 'plugin', ...args], { env, cwd: home, timeout: 20_000 })).stdout;
    const unpack = join(home, 'delivery');
    await fs.mkdir(unpack);
    await execute('tar', ['-xzf', artifact, '-C', unpack]);
    const pkg = join(unpack, 'package');
    expect(JSON.parse(await fs.readFile(join(pkg, 'package.json'), 'utf8')).name).toBe('installed-tool-discovery');
    expect(await fs.readdir(pkg).then(files => files.sort())).toEqual(['README.md', 'index.mjs', 'package.json', 'plugin.json']);
    await cli('install', pkg);
    const catalogRoot = join(home, '.afk/plugins', catalog);
    const receipt = JSON.parse(await fs.readFile(join(catalogRoot, 'install.json'), 'utf8'));
    expect(receipt).toMatchObject({ id: catalog, source: pkg, version: '1.0.0' });
    const sdk = join(dirname(join(catalogRoot, receipt.entry)), 'node_modules/@afk/runtime/dist');
    expect(await fs.realpath(sdk)).toBe(runtime);
    await fs.rm(unpack, { recursive: true });
    workspace = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'w11-consumer-')));
    await test({ home, runtime, env, cliVersion, cli, workspace });
  } finally {
    if (workspace) await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function consumeExcludedTool(entry: typeof recallCases[number], profile: Profile, workspace: string) {
  const { home, runtime, env, cli } = profile;
  const { target, applicability, prompt, scope } = entry.query;
  const claude = process.env.AFK_W11_TOOL_NEGATIVE_AGENT === 'claude-code';
  const agent = claude ? 'claude-code' : 'opencode';
  const evidence = await fs.mkdtemp(join(tmpdir(), `w11-${entry.id}-native-`));
  const scenario = join(home, 'scenario.json');
  const settings = join(home, 'execution-context.json');
  const contextFile = join(workspace, '.afk/experience-context.md');
  const answerFile = join(workspace, 'answer.json');
  await fs.writeFile(settings, JSON.stringify({ enabled: false, executionContexts: [{ target, applicability }] }));
  await cli('configure', 'learning.distiller', '--builtin', '--file', settings);
  await fs.writeFile(scenario, JSON.stringify({ instructions: `请读取 ${JSON.stringify(contextFile)}。从该文件选择与问题匹配的完整工具路由对象，写入 ${JSON.stringify(answerFile)} 的 route 字段。文件不存在或无匹配时该字段填 null。只使用该文件作为路由来源，写好答案即结束。请勿搜索其他目录、提交或推送。` }));
  const userHome = userInfo().homedir;
  const claudeConfig = process.env.CLAUDE_CONFIG_DIR ?? join(userHome, '.claude');
  const sessionEnv = { ...process.env, ...env, PWD: workspace, INIT_CWD: workspace,
    ...(claude && { CLAUDE_CONFIG_DIR: claudeConfig }),
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? join(userHome, '.config'),
    XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? join(userHome, '.local/share') };
  const itemId = String(47 + Number(entry.id.slice(-2)));
  console.info(`Managed ${entry.id} ${agent} evidence: ${evidence}`);
  await execute(process.execPath, [driver, 'consume', runtime, home, prompt, scope, evidence, itemId, scenario, agent],
    { cwd: workspace, env: sessionEnv, timeout: 200_000 });
  const report = JSON.parse(await fs.readFile(join(evidence, 'result.json'), 'utf8'));
  expect(report.result).toEqual({ success: true });
  expect(report.workItemId).toBe(`${scope}#${itemId}`);
  expect(report.retrievals).toEqual([{ query: expect.objectContaining({ scope, target: expect.objectContaining(target!), applicability,
    prompt: expect.stringContaining(prompt) }), origins: [] }]);
  expect(report.events).toContainEqual(expect.objectContaining({ kind: 'step.completed', stepId: 'implement', outcome: 'succeeded' }));
  expect(report.events).not.toContainEqual(expect.objectContaining({ command: 'experience.recall', accepted: true }));
  await expect(fs.lstat(contextFile)).rejects.toMatchObject({ code: 'ENOENT' });
  const answer = JSON.parse(await fs.readFile(answerFile, 'utf8'));
  expect(answer).toEqual({ route: null });
  await fs.copyFile(answerFile, join(evidence, 'answer.json'));
  const sessions = report.events.filter((event: { kind: string }) => event.kind === 'agent.session_recorded');
  expect(sessions).toHaveLength(1);
  const sessionId = sessions[0].sessionId;
  if (claude) {
    expect(sessionId).toMatch(/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    const { claudeProjectSlug } = await import(pathToFileURL(join(runtime, 'shared/agent-transcript-path.js')).href);
    const raw = await fs.readFile(join(claudeConfig, 'projects', claudeProjectSlug(workspace), `${sessionId}.jsonl`), 'utf8');
    await fs.writeFile(join(evidence, 'native.jsonl'), raw, { mode: 0o600 });
    const transcript = raw.trim().split('\n').map(line => JSON.parse(line));
    expect(transcript.some(message => message.type === 'user' && JSON.stringify(message.message?.content).includes(prompt))).toBe(true);
    for (const marker of [plugin, 'verification.provider', source.description, 'plugin invoke']) expect(raw).not.toContain(marker);
    const calls = transcript.filter(message => message.type === 'assistant').flatMap(message => message.message?.content ?? []);
    const contextRead = calls.find(call => call.type === 'tool_use' &&
      ((call.name === 'Read' && call.input?.file_path?.endsWith('.afk/experience-context.md')) ||
       (call.name === 'Bash' && call.input?.command?.includes('.afk/experience-context.md'))));
    expect(contextRead).toBeDefined();
    return { runId: report.runId, workItemId: report.workItemId, sessionId, answer, retrieval: report.retrievals[0], agent,
      contextRead: contextRead!.name, messages: transcript.length, nativeExportSha256: createHash('sha256').update(raw).digest('hex') };
  }
  expect(sessionId).toMatch(/^ses_/);
  const { stdout } = await execute('opencode', ['session', 'export', sessionId, '--standalone'], { cwd: workspace,
    env: { ...sessionEnv, HOME: userHome }, maxBuffer: 8 * 1024 * 1024 });
  await fs.writeFile(join(evidence, 'native.json'), stdout, { mode: 0o600 });
  const transcript = JSON.parse(stdout);
  expect(transcript.info.id).toBe(sessionId);
  expect(transcript.messages).toContainEqual(expect.objectContaining({ type: 'user', text: expect.stringContaining(prompt) }));
  expect(transcript.messages).toContainEqual(expect.objectContaining({ type: 'assistant' }));
  const messages = JSON.stringify(transcript.messages);
  for (const marker of [plugin, 'verification.provider', source.description, 'plugin invoke']) expect(messages).not.toContain(marker);
  type NativePart = { type: string; name?: string; state?: { input?: { path?: string; command?: string } } };
  const calls: NativePart[] = transcript.messages.flatMap((message: { type: string; content?: NativePart[] }) =>
    message.type === 'assistant' ? message.content?.filter(part => part.type === 'tool') ?? [] : []);
  const contextRead = calls.find(call => (call.name === 'read' && call.state?.input?.path?.endsWith('.afk/experience-context.md')) ||
    (call.name === 'shell' && call.state?.input?.command?.includes('.afk/experience-context.md')));
  expect(contextRead).toBeDefined();
  return { runId: report.runId, workItemId: report.workItemId, sessionId, answer, retrieval: report.retrievals[0], agent,
    contextRead: contextRead!.name, messages: transcript.messages.length, nativeExportSha256: createHash('sha256').update(stdout).digest('hex') };
}

it.skipIf(!installed).each(recallCases.filter(entry => entry.kind === 'tool'))('observes installed tool discovery $id', entry =>
  withProfile(entry.id, async profile => {
    const { home, runtime, env, cliVersion, cli } = profile;
    const liveExclude = entry.expected === 'exclude' && process.env.AFK_W11_TOOL_NEGATIVE_LIVE === '1';
    const consumerWorkspace = liveExclude ? profile.workspace : home;
    let native: Awaited<ReturnType<typeof consumeExcludedTool>> | undefined;
    const inputFile = join(home, 'input.json');
    const invoke = async (route: Route, input: unknown) => {
      await fs.writeFile(inputFile, JSON.stringify(input));
      return JSON.parse(await cli('invoke', route.capability, route.provider, route.operation, '--input', inputFile, '--json'));
    };
    const gather = (query: ContextQuery): Promise<ContextFragment[]> => invoke({ capability: 'context.provider', provider: catalog, operation: 'gather' }, query);
    const observe = async (): Promise<ContextFragment[]> => {
      await fs.writeFile(inputFile, JSON.stringify(entry.query));
      const consumer = `
        import { readFile } from 'node:fs/promises';
        const [sdk, input, provider] = process.argv.slice(1);
        const { createDefaultPluginRuntime, createCapabilityLifecycle } = await import(sdk);
        const runtime = await createDefaultPluginRuntime();
        try {
          const query = JSON.parse(await readFile(input, 'utf8'));
          const lifecycle = createCapabilityLifecycle(runtime, { contexts: [{ provider, query: () => query,
            consume: fragments => process.stdout.write(JSON.stringify(fragments)) }] });
          await lifecycle.onBeforeAgent({ worktreePath: process.cwd() });
        } finally { await runtime.dispose(); }`;
      const sdk = pathToFileURL(join(runtime, 'plugin-sdk/index.js')).href;
      return JSON.parse((await execute(process.execPath, ['--input-type=module', '--eval', consumer, sdk, inputFile, catalog],
        { env, cwd: home, timeout: 20_000 })).stdout);
    };
    const proposed = join(home, 'proposed-tool');
    await fs.mkdir(proposed);
    const { stdout: pack } = await execute('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', home], { cwd: toolPackage });
    const delivery = join(home, JSON.parse(pack)[0].filename);
    await execute('tar', ['-xzf', delivery, '--strip-components=1', '-C', proposed]);
    const pluginRoot = join(home, '.afk/plugins', plugin);
    const receiptPath = join(pluginRoot, 'install.json');
    const loaded = async () => JSON.parse(await cli('list', '--loaded', '--json')) as { id: string; providers: string[] }[];
    const checkAbsent = async () => {
      await expect(fs.stat(receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await loaded()).map(row => row.id)).not.toContain(plugin);
      await expect(invoke({ capability: 'verification.provider', provider: plugin, operation: 'verify' }, { target: source.project, input: '0' }))
        .rejects.toMatchObject({ stderr: expect.stringContaining('Capability provider is not registered') });
    };
    const baseline = recallCases.find(item => item.id === 'tool-01')!.query;
    let observed: ContextFragment[];
    if (entry.state === 'proposal') {
      await checkAbsent();
      observed = await observe();
      if (liveExclude) native = await consumeExcludedTool(entry, profile, consumerWorkspace);
    }
    await cli('install', proposed);
    const receipt: Receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    expect(receipt).toMatchObject({ id: plugin, version: manifest.version, source: proposed, manifest });
    const codePath = join(pluginRoot, receipt.entry);
    const sourcePath = join(dirname(codePath), 'source.json');
    const integrity = `sha256-${createHash('sha256').update(await fs.readFile(codePath)).digest('base64')}`;
    expect(receipt.integrity).toBe(integrity);
    const installedSource = await fs.readFile(sourcePath, 'utf8');
    expect(createHash('sha256').update(installedSource).digest('hex')).toBe(receipt.manifest.sourceDigest);
    const grant = { project: source.project, plugin: receipt.id, version: receipt.version, source: pathToFileURL(sourcePath).href, digest };
    const configure = async (effect: 'allow' | 'deny', workspace = consumerWorkspace) => {
      await fs.writeFile(inputFile, JSON.stringify({ defaultEffect: 'deny', sharedVerification: [sharedGrant(receipt, source.project, workspace)],
        rules: [{ id: 'scan-source', actions: ['tool.source.read'], when: grant, effect }] }));
      await cli('configure', 'policy.compliance-policy', '--builtin', '--file', inputFile);
    };
    await configure('allow');
    const origin = `${receipt.id}@${receipt.version}`;
    const control = await gather(baseline);
    expect(control.map(result => result.origin)).toEqual([origin]);
    const route = JSON.parse(control[0]!.content);
    expect(route).toEqual({ capability: 'verification.provider', provider: plugin, operation: 'verify', description: source.description });
    const verify = (input: string) => invoke(route, { target: source.project, input });
    const loadedTool = { id: receipt.id, providers: [route.provider] };
    expect(await loaded()).toContainEqual(expect.objectContaining(loadedTool));
    if (entry.expected === 'hit') {
      const alias = entry.id === 'tool-02';
      if ((entry.id === 'tool-01' && process.env.AFK_W11_TOOL01_LIVE === '1') || (alias && process.env.AFK_W11_TOOL02_LIVE === '1')) {
        const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'w11-tool-work-item-')));
        const workspace = join(directory, 'workspace');
        await fs.mkdir(workspace);
        await configure('allow', workspace);
        await fs.writeFile(inputFile, JSON.stringify({ enabled: false, executionContexts: [{
          target: entry.query.target, applicability: entry.query.applicability }] }));
        await cli('configure', 'learning.distiller', '--builtin', '--file', inputFile);
        const itemId = alias ? '48' : '47';
        const scan = { target: source.project, input: alias ? '9780306406158\n9780306406157\n5012345678900\n5012345678901' : '4006381333931\n4006381333932\n5901234123457' };
        await fs.writeFile(join(workspace, 'manifest.json'), JSON.stringify(scan));
        const launcher = join(directory, 'afk.cjs');
        const binary = await fs.realpath(installed!);
        await fs.writeFile(launcher, `#!${process.execPath}\n` +
          `const {spawnSync}=require('node:child_process'),fs=require('node:fs');\n` +
          `const args=process.argv.slice(2), r=spawnSync(process.execPath,[${JSON.stringify(binary)},...args],` +
          `{env:${JSON.stringify(env)},encoding:'utf8'});\n` +
          `fs.appendFileSync(${JSON.stringify(join(directory, 'calls.jsonl'))},JSON.stringify({args,status:r.status,stdout:r.stdout})+'\\n');\n` +
          `process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');process.exit(r.status??1);\n`, { mode: 0o700 });
        const scenario = join(directory, 'scenario.json');
        await fs.writeFile(scenario, JSON.stringify({ instructions: `只读取当前工作区的 .afk/experience-context.md 获取工具路由。使用 ${launcher} plugin invoke <capability> <provider> <operation> --input manifest.json --json 调用该路由一次。退出码 1 表示校验发现错误，stdout 仍是有效 JSON。将其 output 中的 checked 和 invalidLines 写入当前工作区的 answer.json。写入成功后直接按下方 AFK 完成协议回复，不再调用工具或搜索其他文件。` }));
        await fs.copyFile(delivery, join(directory, 'scan-manifest.tgz'));
        await fs.writeFile(join(directory, 'installation.json'), JSON.stringify({ cliVersion, tool: receipt, grant, sharedGrant: sharedGrant(receipt, source.project, workspace), catalog: JSON.parse(await fs.readFile(join(home, '.afk/plugins', catalog, 'install.json'), 'utf8')) }));
        console.info(`Managed ${entry.id} evidence: ${directory}`);
        const userHome = userInfo().homedir;
        await execute(process.execPath, [driver, 'consume', runtime, home, entry.query.prompt, source.project, directory, itemId, scenario], {
          cwd: workspace, timeout: 200_000, env: { ...process.env, ...env, PWD: workspace, INIT_CWD: workspace,
            XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? join(userHome, '.config'),
            XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? join(userHome, '.local/share') } });
        const report = JSON.parse(await fs.readFile(join(directory, 'result.json'), 'utf8'));
        expect(report.result).toEqual({ success: true });
        expect(report.workItemId).toBe(`${source.project}#${itemId}`);
        expect(report.retrievals).toEqual([expect.objectContaining({ query: expect.objectContaining({ scope: source.project,
          prompt: expect.stringContaining(entry.query.prompt), applicability: entry.query.applicability, target: expect.objectContaining(entry.query.target!) }), origins: [origin] })]);
        expect(report.events).toContainEqual(expect.objectContaining({ kind: 'agent.session_recorded', sessionId: expect.stringMatching(/^ses_/) }));
        const business = alias ? { checked: 4, invalidLines: [1, 4] } : { checked: 3, invalidLines: [2] };
        const calls = (await fs.readFile(join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        expect(calls).toHaveLength(1);
        const call = calls.find(row => row.status === 1 && row.args.slice(0, 5).join(' ') === `plugin invoke ${route.capability} ${route.provider} ${route.operation}`);
        expect(JSON.parse(call.stdout)).toMatchObject({ passed: false, output: JSON.stringify(business) });
        expect(JSON.parse(await fs.readFile(join(workspace, 'answer.json'), 'utf8'))).toEqual(business);
        expect(JSON.parse(await fs.readFile(join(workspace, 'manifest.json'), 'utf8'))).toEqual(scan);
      }
      observed = await observe();
      expect(observed).toEqual(control);
      const selected = JSON.parse(observed[0]!.content);
      for (const [input, invalidLines] of [['4006381333931', []], ['4006381333931\n4006381333932', [2]]] as const) {
        const attempt = invoke(selected, { target: source.project, input });
        if (invalidLines.length) await expect(attempt).rejects.toMatchObject({ code: 1, stderr: '' });
        const result = invalidLines.length ? await attempt.catch(error => JSON.parse(error.stdout)) : await attempt;
        expect(result.passed).toBe(!invalidLines.length);
        expect(JSON.parse(result.output)).toEqual({ checked: input.split('\n').length, invalidLines });
      }
      expect(await gather({ ...entry.query, prompt: '如何核对袋号？' })).toEqual([]);
    } else if (entry.state === 'revoked') {
      await configure('deny');
      observed = await observe();
      await expect(verify('4006381333931')).rejects.toMatchObject({ stderr: expect.stringContaining('Tool source read denied') });
      expect(await loaded()).toContainEqual(expect.objectContaining(loadedTool));
      expect(JSON.parse(await fs.readFile(receiptPath, 'utf8'))).toEqual(receipt);
      expect(await fs.readFile(sourcePath, 'utf8')).toBe(installedSource);
    } else if (entry.state === 'uninstalled') {
      await cli('remove', plugin);
      await checkAbsent();
      observed = await observe();
    } else if (entry.state !== 'proposal') {
      observed = await observe();
      expect(await gather(baseline)).toEqual(control);
    }
    if (liveExclude) {
      native ??= await consumeExcludedTool(entry, profile, consumerWorkspace);
      if (entry.state === 'revoked') await configure('allow');
      const controlQuery = { ...native.retrieval.query, applicability: baseline.applicability };
      if (entry.state !== 'uninstalled') expect(await gather(controlQuery)).toEqual(control);
      console.info(JSON.stringify({ caseId: entry.id, cliVersion, state: entry.state, native, tool: receipt,
        positiveControl: { query: entry.state === 'uninstalled' ? baseline : controlQuery, route, origin,
          timing: entry.state === 'uninstalled' ? 'before removal' : 'after managed observation' } }));
    }
    const ranked = observed!.map(fragment => {
      expect(fragment.origin).toBe(origin);
      return { scope: JSON.parse(installedSource).project, key: receipt.id.slice('tool.'.length), edition: Number(receipt.version.split('.')[0]) };
    });
    assertObservedRecall(entry, { caseId: entry.id, status: 'observed', ranked });
    console.log(JSON.stringify({ caseId: entry.id, cliVersion, origin, integrity, sourceDigest: digest, installedAt: receipt.installedAt,
      control: control.map(fragment => fragment.origin), observation: observed!.map(fragment => fragment.origin), controlAfterObservation: entry.state === 'proposal' }));
  }), 240_000);

it.skipIf(!installed)('keeps the authorized verifier discoverable alongside broken third-party descriptions', () =>
  withProfile('tool-isolation', async ({ cli, home, runtime, env }) => {
    const otherProject = 'github:w11/returns';
    const descriptions = {
      'tool.bad-json': '{',
      'tool.bad-names': JSON.stringify({ ...source, names: null }),
      'tool.bad-versions': JSON.stringify({ ...source, productVersions: [] }),
      'tool.bad-description': JSON.stringify({ ...source, description: { invalid: true } }),
      'tool.returns': JSON.stringify({ ...source, project: otherProject }),
      [plugin]: sourceBytes,
    };
    const rules = [];
    const sharedVerification = [];
    for (const [id, bytes] of Object.entries(descriptions)) {
      const directory = join(home, id);
      const sourceDigest = createHash('sha256').update(bytes).digest('hex');
      await fs.mkdir(directory);
      await fs.copyFile(join(toolPackage, manifest.entry), join(directory, manifest.entry));
      await fs.writeFile(join(directory, 'source.json'), bytes);
      await fs.writeFile(join(directory, 'plugin.json'), JSON.stringify({ ...manifest, id, sourceDigest }));
      await fs.writeFile(join(directory, 'package.json'), JSON.stringify({ name: id, version: manifest.version }));
      await cli('install', directory);
      const root = join(home, '.afk/plugins', id);
      const receipt: Receipt = JSON.parse(await fs.readFile(join(root, 'install.json'), 'utf8'));
      if (id === plugin) sharedVerification.push(sharedGrant(receipt, source.project, home));
      const url = pathToFileURL(join(root, dirname(receipt.entry), 'source.json')).href;
      rules.push({ id, actions: ['tool.source.read'], effect: 'allow', when: {
        plugin: receipt.id, version: receipt.version, project: id === 'tool.returns' ? otherProject : source.project, source: url, digest: sourceDigest,
      } });
    }
    const countId = 'verification.carton-count';
    const counter = join(home, countId);
    await fs.mkdir(counter);
    await fs.writeFile(join(counter, 'plugin.json'), JSON.stringify({ ...manifest, id: countId, version: '1.1.0' }));
    await fs.writeFile(join(counter, 'package.json'), JSON.stringify({ name: countId, version: '1.1.0' }));
    await fs.writeFile(join(counter, 'count.mjs'), `export {count} from './words.mjs';`);
    await fs.writeFile(join(counter, 'words.mjs'), `export const count = input => input.trim().split(/\\s+/).length;`);
    await fs.writeFile(join(counter, 'index.mjs'), `import manifest from './plugin.json' with { type: 'json' };
      export default {manifest, activate(context) { context.registerVerificationProvider(manifest.id, {id: manifest.id,
        capabilities: {'static-analysis':true,'test-execution':false,'custom-script':false},
        async verify({input}) { const {count} = await import('./count.mjs'); return {passed: true, durationMs: 0, output: String(count(input))}; }
      }); }};`);
    await cli('install', counter);
    const countReceipt = JSON.parse(await fs.readFile(join(home, '.afk/plugins', countId, 'install.json'), 'utf8'));
    expect(countReceipt.integrity).not.toBe(sharedVerification[0]!.integrity);
    sharedVerification.push(sharedGrant(countReceipt, otherProject, home));
    const loaded = JSON.parse(await cli('list', '--loaded', '--json'));
    for (const id of Object.keys(descriptions)) expect(loaded).toContainEqual(expect.objectContaining({ id, providers: [id] }));
    const input = join(home, 'input.json');
    const policyPath = join(home, 'initial-policy.json');
    await fs.writeFile(policyPath, JSON.stringify({ defaultEffect: 'deny', rules, sharedVerification }));
    await cli('configure', 'policy.compliance-policy', '--builtin', '--file', policyPath);
    await fs.writeFile(input, JSON.stringify(recallCases.find(entry => entry.id === 'tool-01')!.query));
    const fragments: ContextFragment[] = JSON.parse(await cli('invoke', 'context.provider', catalog, 'gather', '--input', input, '--json'));
    expect(fragments.map(fragment => fragment.origin)).toEqual([`${plugin}@${manifest.version}`]);
    const route = JSON.parse(fragments[0]!.content);
    await fs.writeFile(input, JSON.stringify({ target: source.project, input: '4006381333931' }));
    expect(JSON.parse(await cli('invoke', route.capability, route.provider, route.operation, '--input', input, '--json')).passed).toBe(true);
    await fs.writeFile(input, JSON.stringify(recallCases.find(entry => entry.id === 'tool-01')!.query));
    const check = join(repo, 'tests/fixtures/w11/installed-tool-boundary.mjs');
    const { stdout } = await execute(process.execPath, [check, runtime, input, installed!, otherProject, policyPath, countId], { env, cwd: home });
    console.log(stdout.trim());
    console.log(JSON.stringify({ installedAndGranted: Object.keys(descriptions), discovered: fragments.map(item => item.origin) }));
  }), 60_000);
