import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const [binary, output, mode] = process.argv.slice(2);
if (!binary || !output) throw new Error('Usage: node agent-cursor.mjs INSTALLED_AFK NEW_RECEIPT');
const release = dirname(dirname(realpathSync(binary)));
if (mode !== 'driver') {
  process.umask(0o077);
  const receipt = resolve(output);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'w10-cursor-')));
  try {
    const project = join(root, 'project');
    mkdirSync(project);
    const env = Object.fromEntries(['HOME', 'PATH', 'LANG', 'XDG_CONFIG_HOME', 'CURSOR_API_KEY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']
      .filter(key => process.env[key]).map(key => [key, process.env[key]]));
    Object.assign(env, { TMPDIR: root, AFK_HOME: join(root, 'afk'), AFK_EVENT_STORE_DIR: join(root, 'events'), NO_OPEN_BROWSER: '1' });
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), realpathSync(binary), join(root, 'result.json'), 'driver'],
      { cwd: project, env, stdio: 'ignore', timeout: 150_000 });
    const resultPath = join(root, 'result.json');
    const fallback = { passed: false, phase: 'driver', timedOut: result.error?.code === 'ETIMEDOUT', driverExitCode: result.status };
    writeFileSync(receipt, existsSync(resultPath) ? readFileSync(resultPath) : JSON.stringify(fallback) + '\n', { flag: 'wx' });
    process.exitCode = result.status ?? 1;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
} else {
  const report = { passed: false, phase: 'installation' };
  let plugins;
  try {
    const manifest = JSON.parse(readFileSync(join(release, 'release.json')));
    const { platform, arch } = manifest;
    const afk = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
    const digest = basename(release).match(/^0\.2\.156-(darwin|linux)-(arm64|x64)-([a-f0-9]{64})$/);
    assert.ok(afk === '0.2.156' && manifest.version === afk && digest?.[1] === platform && digest[2] === arch);
    const cursor = execFileSync('cursor-agent', ['--version'], { encoding: 'utf8', timeout: 15000 }).trim();
    assert.match(cursor, /^[\d.]+-[\da-f]+$/i);
    Object.assign(report, { afk, cursor, platform, arch, archiveSha256: digest[3], phase: 'authentication' });
    const status = spawnSync('cursor-agent', ['status', '--format', 'json'], { encoding: 'utf8', timeout: 20000 });
    report.statusExitCode = status.status;
    const authenticated = JSON.parse(status.stdout).isAuthenticated;
    assert.equal(typeof authenticated, 'boolean');
    report.authenticated = authenticated;
    assert.ok(authenticated && status.status === 0);

    const project = process.cwd(), root = dirname(project);
    report.phase = 'native-control';
    const controlProject = join(root, 'native-control');
    mkdirSync(controlProject);
    const controlLeft = randomInt(1000, 5000), controlRight = randomInt(5000, 9000);
    const direct = spawnSync('cursor-agent', ['--print', '--output-format', 'stream-json'], {
      cwd: controlProject, encoding: 'utf8', timeout: 35000,
      input: `Add ${controlLeft} and ${controlRight}. Reply with only the decimal sum. Do not use tools.\n`,
    });
    const messages = (direct.stdout ?? '').split('\n').flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    const init = messages.find(event => event?.type === 'system' && event.subtype === 'init');
    const resultEvent = messages.find(event => event?.type === 'result');
    report.nativeControl = {
      exitCode: direct.status, timedOut: direct.error?.code === 'ETIMEDOUT', initSeen: Boolean(init), resultSeen: Boolean(resultEvent),
      sessionMatches: Boolean(init?.session_id && init.session_id === resultEvent?.session_id),
      answerMatches: resultEvent?.subtype === 'success' && !resultEvent.is_error && String(resultEvent.result).trim() === String(controlLeft + controlRight),
      authenticationRequired: /authentication required/i.test(`${direct.stderr ?? ''}\n${direct.stdout ?? ''}`),
    };
    report.phase = 'workflow';
    const load = name => import(join(release, 'node_modules/@afk/runtime/dist', `${name}.js`));
    const { WorkflowRunner } = await load('application/workflow-engine');
    const { createDefaultPluginRuntime } = await load('plugin-sdk/index');
    const { createRunObserver } = await load('infrastructure/observability/run-observer-factory');
    const git = (...args) => execFileSync('git', args, { stdio: 'ignore' });
    git('init', '-b', 'main');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'synthetic');
    const left = randomInt(1000, 5000), right = randomInt(5000, 9000);
    const goal = `Add ${left} and ${right}. Do not use tools. Return only <goal_complete>{"type":"goal_complete","kind":"task","summary":"SUM=NUMBER"}</goal_complete> with NUMBER replaced by the decimal sum.`;
    const template = join(root, 'flow.yml');
    writeFileSync(template, `name: cursor-qualification\nversion: 1\nsteps:\n  - id: implement\n    kind: agent\n    role: implementer\n    prompt: |-\n      ${goal}\n  - id: queue\n    kind: system\n    action: queue-qa\n    dependsOn: [implement]\n`);
    const workItemId = 'github:fixture/cursor#1', branchName = 'feat/fixture', runId = randomUUID();
    const item = { id: '1', issueNumber: 1, workItemId, providerRef: workItemId, title: goal, description: goal,
      kind: 'task', state: 'ready', executionMode: 'afk', branchName, dependsOn: [], tags: [] };
    const providers = {
      backlog: { get: async () => item, claim: async () => ({ item, release: async () => {}, heartbeat: async () => {} }),
        getActiveRework: async () => null, setExecutionMode: async () => {}, addComment: async () => {}, transition: async (_id, state) => { item.state = state; } },
      branches: { createBranch: async () => { git('checkout', '-b', branchName); return { branchName, worktreePath: project }; }, cleanup: async () => {} },
      changes: { findForBacklog: async () => null },
    };
    let initSession, resultSession, recordedSession, closed;
    Object.assign(report, { nativeStarts: 0, expectedSum: left + right, initSeen: false, resultSeen: false, answerMatches: false });
    const markers = new Set();
    function checkDiagnostic(line) {
      for (const marker of ['untrusted', 'trust', 'unauthenticated', 'login required', 'authentication required', 'rate limit', 'quota', 'network', 'connection', 'model unavailable']) {
        if (line.toLowerCase().includes(marker)) markers.add(marker);
      }
    }
    channel('tracing:child_process.spawn:start').subscribe(({ process: child, options }) => {
      if (options.file !== 'cursor-agent') return;
      report.nativeStarts++;
      report.batchArgvMatches = JSON.stringify(options.args) === JSON.stringify(['cursor-agent', '--print', '--output-format', 'stream-json']);
      report.spawnCwdMatches = String(options.cwd) === project;
      closed = new Promise(resolveClose => child.once('close', (code, signal) => {
        report.nativeExitCode = code;
        report.nativeSignal = signal;
        resolveClose();
      }));
      child.once('spawn', () => {
        createInterface({ input: child.stderr }).on('line', checkDiagnostic);
        createInterface({ input: child.stdout }).on('line', line => {
          let event;
          try { event = JSON.parse(line); } catch { checkDiagnostic(line); return; }
          if (event.type === 'system' && event.subtype === 'init') { report.initSeen = true; initSession = event.session_id; }
          if (event.type !== 'result') return;
          report.resultSeen = true;
          resultSession = event.session_id;
          report.answerMatches = !event.is_error && event.subtype === 'success' && new RegExp(`SUM=${left + right}(?!\\d)`).test(event.result);
          if (event.is_error) checkDiagnostic(String(event.result));
        });
      });
    });
    plugins = await createDefaultPluginRuntime({ homeDir: join(root, 'profile'), workspaceRoot: project });
    const observer = createRunObserver(process.env.AFK_EVENT_STORE_DIR, [], { onPersisted: async ({ context, data }) => {
      if (context.runId === runId && context.workItemId === workItemId && data.kind === 'agent.session_recorded') recordedSession = data.sessionId;
    } });
    const runner = new WorkflowRunner(providers, { plugins, observer });
    try {
      const result = await runner.run({ backlogId: '1', workItemId, session: runId, observationWorkItemId: workItemId, observationRunId: runId,
        targetBranch: branchName, baseBranch: 'main', baseBranchExplicit: true, repoRoot: project, workspaceRoot: project, template,
        agentProvider: 'cursor', sandboxProvider: 'local', executionMode: 'batch', completionTimeoutMs: 45000, hardTimeoutMs: 65000, maxRetries: 0, maxHandoffs: 1 });
      report.workflowSuccess = result.success;
    } finally {
      await closed;
      report.state = item.state;
      report.diagnosticMarkers = [...markers];
      report.sessionMatches = typeof initSession === 'string' && initSession.length > 0 && initSession === resultSession && resultSession === recordedSession;
    }
    assert.ok(report.nativeControl.exitCode === 0 && report.nativeControl.sessionMatches && report.nativeControl.answerMatches);
    assert.ok(report.workflowSuccess && report.state === 'verification' && report.nativeStarts === 1 && report.batchArgvMatches && report.spawnCwdMatches
      && report.sessionMatches && report.answerMatches && report.nativeExitCode === 0);
    Object.assign(report, { passed: true, phase: 'complete' });
  } catch {
    process.exitCode = 1;
  } finally {
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    await plugins?.dispose();
  }
}
