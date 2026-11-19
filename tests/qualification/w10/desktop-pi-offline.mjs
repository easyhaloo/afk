/** macOS: node desktop-pi-offline.mjs <AFK Control.app> <@playwright/test directory> <cached Qwen3.5-2B snapshot> [--work-item] */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const [bundle, playwright, snapshot] = process.argv.slice(2).map(value => resolve(value));
const ticket = process.argv[5] === '--work-item';
const pin = '15852e8c16360a2fea060d615a32b45270f8a8fc';
assert(process.platform === 'darwin' && basename(snapshot) === pin && readdirSync(snapshot).some(name => name.endsWith('.safetensors')));
const policy = '(version 1)(allow default)(deny network-outbound (remote ip "*:*"))(allow network-outbound (remote ip "localhost:*"))';
const root = process.send ? process.env.DESKTOP_PI_SCRATCH : undefined;
if (!root) {
  const scratch = realpathSync(mkdtempSync('/tmp/desktop-pi-'));
  try {
    const bin = join(scratch, 'bin');
    mkdirSync(bin);
    for (const tool of ['pi', 'ollama', 'tmux', 'rg', 'node']) {
      const target = execFileSync('/usr/bin/which', [tool], { encoding: 'utf8' }).trim();
      symlinkSync(realpathSync(target), join(bin, tool === 'pi' ? 'native-pi' : tool));
    }
    const env = { HOME: scratch, USERPROFILE: scratch, CFFIXED_USER_HOME: scratch, TMPDIR: scratch, TMUX_TMPDIR: scratch,
      DESKTOP_PI_SCRATCH: scratch, XDG_CONFIG_HOME: join(scratch, '.config'), PATH: `${bin}:/usr/bin:/bin`, SHELL: '/bin/sh',
      GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', PI_OFFLINE: '1', PI_CODING_AGENT_DIR: join(scratch, '.pi/agent'),
      OLLAMA_MODELS: join(scratch, 'models'), OLLAMA_NO_CLOUD: '1', AFK_AGENT_DEFAULT: 'pi', LANG: 'en_US.UTF-8',
      AFK_WORKFLOW_HARD_TIMEOUT: '45000', AFK_COMPLETION_TIMEOUT: '30000', AFK_COMPLETION_POLL: '1', AFK_MAX_RETRIES: '0' };
    const ps = createServer((req, res) => {
      const pid = /^\/(\d+)$/.exec(req.url)?.[1];
      if (!pid || req.method !== 'GET') return res.writeHead(400).end();
      try {
        let ancestor = Number(pid);
        while (ancestor > 1 && ancestor !== child.pid) ancestor = Number(execFileSync('/bin/ps', ['-p', String(ancestor), '-o', 'ppid='], { encoding: 'utf8' }).trim());
        assert.equal(ancestor, child.pid);
        res.end(execFileSync('/bin/ps', ['-o', 'lstart=', '-p', pid]));
      } catch { res.writeHead(404).end(); }
    }).listen(0, '127.0.0.1');
    await once(ps, 'listening');
    writeFileSync(join(bin, 'ps'), `#!/bin/sh\n[ "$#" = 4 ] && [ "$1" = -o ] && [ "$2" = lstart= ] && [ "$3" = -p ] || exit 1\ncase "$4" in ''|*[!0-9]*) exit 1;; esac\nexec /usr/bin/curl -qfsS --max-time 2 http://127.0.0.1:${ps.address().port}/"$4"\n`, { mode: 0o700 });
    if (ticket) Object.assign(env, { AFK_WORKFLOW_HARD_TIMEOUT: '180000', AFK_COMPLETION_TIMEOUT: '120000', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@invalid' });
    const child = spawn('/usr/bin/sandbox-exec', ['-p', policy, process.execPath, fileURLToPath(import.meta.url), bundle, playwright, snapshot, ...(ticket ? ['--work-item'] : [])],
      { env, cwd: scratch, detached: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(kill, ticket ? 600_000 : 300_000);
    try { const [code] = await once(child, 'exit'); process.exitCode = code ?? 1; }
    finally { clearTimeout(timer); kill(); ps.close(); }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
} else {
  await qualify();
}

async function qualify() {
  const report = { checkedAt: new Date().toISOString(), model: 'Qwen3.5-2B', revision: pin, source: 'cached safetensors / ephemeral loopback Ollama', passed: false };
  const work = join(root, 'work');
  mkdirSync(work);
  const run = (command, ...args) => execFileSync(command, args, { cwd: work, timeout: 120_000, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  const server = createServer();
  let daemon, app;
  try {
    const reserve = createServer().listen(0, '127.0.0.1');
    await once(reserve, 'listening');
    const endpoint = `http://127.0.0.1:${reserve.address().port}`;
    await new Promise(done => reserve.close(done));
    process.env.OLLAMA_HOST = new URL(endpoint).host;
    daemon = spawn('ollama', ['serve'], { stdio: 'ignore' });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (daemon.exitCode !== null) throw Error('ollama-start');
      try { report.ollama = (await (await fetch(`${endpoint}/api/version`)).json()).version; break; } catch { await delay(100); }
    }
    assert(report.ollama);
    const model = 'desktop-qwen:latest';
    writeFileSync(join(root, 'Modelfile'), `FROM ${snapshot}\nPARAMETER temperature 0\nPARAMETER num_ctx 4096\n`);
    run('ollama', 'create', model, '-f', join(root, 'Modelfile'));
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { local: { baseUrl: `${endpoint}/v1`, api: 'openai-completions',
      apiKey: 'loopback', models: [{ id: model, contextWindow: 4096, maxTokens: 1024 }] } } }));
    const launcher = join(root, 'bin/pi');
    const tools = ticket ? '--no-builtin-tools --tools read_ticket,create_answer,read_answer,write_signal -e "$HOME/ticket-tools.mjs"' : '--no-tools';
    if (ticket) writeFileSync(join(root, 'ticket-tools.mjs'), readFileSync(new URL('./desktop-pi-work-item-tools.mjs', import.meta.url)));
    writeFileSync(launcher, `#!/bin/sh\nexec native-pi --offline ${tools} --no-mcp --no-extensions --no-skills --no-context-files --no-prompt-templates --provider local --model desktop-qwen:latest --thinking off "$@"\n`);
    chmodSync(launcher, 0o700);
    report.pi = run('native-pi', '--version');
    const operands = [randomInt(11,20), randomInt(21,30)];
    const prompt = `Reply with only the numeric sum of ${operands.join(' and ')}.`;
    const control = run('pi', '--no-session', '-p', prompt);
    report.standaloneControl = { operands, exactAnswer: control === String(operands[0] + operands[1]) };
    assert(report.standaloneControl.exactAnswer);
    const expected = `ticket-${randomInt(100000,999999)}`;
    const title = ticket ? 'Read the ticket with read_ticket and deliver answer.txt' : 'Identify the assigned backlog context file';
    const description = ticket ? `Acceptance criterion: answer.txt must contain exactly one line: ${expected}. Implementer: call create_answer with that line. Verifier: use read_answer to compare the file with this criterion. Then call write_signal with the kind requested by AFK and your own summary and verdict.` : `Quote the backlog-context filename assigned to this work item. Work item marker ${randomInt(100000,999999)}.`;
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const repoUrl = `${origin}/acme/api.git`;
    process.env.DESKTOP_PI_CHECKOUT = join(root,'.loop-workspace/gitlab/127.0.0.1',new URL(origin).port,'acme/api/1/repositories/api');
    run('git', 'init', '-q', '-b', 'main');
    if (ticket) {
      writeFileSync(join(work,'.gitignore'), '/.claude/settings.local.json\n/.afk-signal.json\n');
      run('git','add','.gitignore');
    }
    run('git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'Synthetic input', '--allow-empty');
    const bare = join(root, 'api.git');
    run('git', 'clone', '--bare', work, bare);
    run('git', 'config', '--global', `url.${pathToFileURL(bare).href}.insteadOf`, repoUrl);
    run('git', 'config', '--global', '--add', `url.${pathToFileURL(bare).href}.insteadOf`, repoUrl.replace('http:', 'https:'));
    run('git', 'remote', 'add', 'origin', repoUrl);
    const project = { id: 1, name: 'api', path_with_namespace: 'acme/api', default_branch: 'main', web_url: `${origin}/acme/api`, http_url_to_repo: repoUrl };
    const issue = { id: 101, iid: 1, project_id: 1, title, description, state: 'opened', labels: ['stage::ready-for-issues','mode::afk'],
      web_url: `${project.web_url}/-/issues/1`, updated_at: new Date().toISOString(), created_at: new Date().toISOString(), assignees: [] };
    const routes = new Set();
    let change;
    server.on('request', async (request, response) => {
      const path = decodeURIComponent(new URL(request.url, origin).pathname).replace('/acme/api/', '/1/').replace(/\/acme\/api$/, '/1');
      if (ticket && request.method === 'POST' && path === '/api/v4/projects/1/merge_requests') {
        routes.add('POST /api/v4/projects/1/merge_requests');
        let body = '';
        for await (const chunk of request) body += chunk;
        const fields = body.startsWith('{') ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
        const source = fields.source_branch;
        if (!/^afk\/backlog-1(?:-qa)?$/.test(source) || fields.target_branch !== 'main' ||
          spawnSync('git',['--git-dir',bare,'merge-base','--is-ancestor','main',source]).status !== 0 ||
          spawnSync('git',['--git-dir',bare,'diff','--quiet','main',source,'--','answer.txt']).status !== 1) return response.writeHead(409).end();
        change = { ...fields, id: 2, iid: 2, state: 'opened', web_url: `${project.web_url}/-/merge_requests/2`, detailed_merge_status: 'mergeable' };
        return response.writeHead(201, {'Content-Type':'application/json'}).end(JSON.stringify(change));
      }
      const data = { '/api/v4/user': { id: 1, username: 'fixture' }, '/api/v4/projects': [project], '/api/v4/projects/1': project,
        '/api/v4/projects/1/issues': [issue], '/api/v4/projects/1/issues/1': issue, '/api/v4/projects/1/issues/1/notes': [], '/api/v4/projects/1/merge_requests': [], '/api/v4/projects/1/issues/1/links': [],
        '/api/v4/projects/1/repository/branches': [{ name: 'main', default: true }], '/api/v4/projects/1/merge_requests/2': change,
        '/api/v4/projects/1/merge_requests/2/closes_issues': change && (/\bcloses\s+#1\b/i.test(change.description) ? [issue] : []) }[path];
      routes.add(`${request.method} ${path}`);
      const update = request.method === 'PUT' && path === '/api/v4/projects/1/issues/1';
      if (update) {
        let body = '';
        for await (const chunk of request) body += chunk;
        const fields = body.startsWith('{') ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
        const labels = value => Array.isArray(value) ? value : (value || '').split(',').filter(Boolean);
        issue.labels = [...new Set([...(fields.labels ? labels(fields.labels) : issue.labels), ...labels(fields.add_labels)])].filter(label => !labels(fields.remove_labels).includes(label));
      }
      const ok = update || (request.method === 'GET' && data !== undefined);
      response.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' }).end(JSON.stringify(ok ? (change && path.endsWith('/merge_requests') ? [change] : data) : { message: 'fixture route unavailable' }));
    });
    const archive = join(bundle, 'Contents/Resources/app.asar');
    report.appAsarSha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
    const { _electron } = await import(pathToFileURL(join(playwright, 'index.mjs')));
    report.phase = 'launch';
    app = await _electron.launch({ executablePath: join(bundle, 'Contents/MacOS/AFK Control'), cwd: work, timeout: 25000,
      args: ['--no-sandbox', '--use-mock-keychain', '--disable-background-networking', `--user-data-dir=${join(root,'profile')}`],
      env: { ...process.env, AFK_WORKSPACE: work, GITLAB_URL: origin, GITLAB_TOKEN: 'synthetic-local' } });
    const page = await app.firstWindow({ timeout: 15000 });
    page.setDefaultTimeout(15000);
    report.desktop = await app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged,
      isolated: app.getPath('userData').startsWith(process.env.HOME + '/'), archive: app.getAppPath() }));
    assert.equal(report.desktop.archive, archive);
    delete report.desktop.archive;
    assert(report.desktop.isolated && report.desktop.packaged);
    assert.equal(decodeURIComponent(new URL(page.url()).pathname), join(archive, 'dist/index.html'));
    report.phase = 'inventory';
    await page.locator('.primary-nav').getByRole('button', { name: '工作项' }).click();
    await page.getByRole('button', { name: '刷新工作项' }).click();
    await page.locator('.backlog-row', { hasText: title }).click();
    await page.getByRole('button', { name: '开始执行', exact: true }).click();
    const setup = page.getByRole('dialog', { name: '开始执行工作项' });
    report.phase = 'submit';
    await setup.getByRole('button', { name: '创建运行' }).click();
    report.phase = 'await-run';
    let checkout;
    const contexts = new Set();
    for (let attempt = 0; attempt < (ticket ? 850 : 180); attempt++) {
      const recordsDir = join(root, '.afk/workspaces');
      for (const entry of existsSync(recordsDir) ? readdirSync(recordsDir) : []) {
        const folder = join(recordsDir, entry);
        const records = join(folder, 'work-item-runs.json');
        if (!existsSync(records)) continue;
        const manifest = JSON.parse(readFileSync(join(folder, 'execution-manifest.json')));
        const [record] = JSON.parse(readFileSync(records));
        assert.equal(manifest.workItemId, `gitlab:${new URL(origin).host}/acme/api#1`);
        assert.equal(createHash('sha256').update(record.workspacePath).digest('hex'), entry);
        checkout = join(record.workspacePath, manifest.repositories[0].checkoutPath);
        const contextDir = join(checkout, '.afk');
        for (const name of existsSync(contextDir) ? readdirSync(contextDir) : []) {
          if (/^backlog-context-[0-9a-f-]{36}\.md$/.test(name) && readFileSync(join(contextDir,name),'utf8').includes(description)) contexts.add(name);
        }
        report.workItem = { issue: 1, branch: manifest.repositories[0].baseBranch, status: record.status };
        if (/^afk run exited with code \d+$/.test(record.error ?? '')) report.workItem.exitCode = Number(record.error.split(' ').pop());
        const journal = join(folder, 'executions', `${record.id}.jsonl`);
        if (['completed','failed'].includes(record.status) && existsSync(journal)) {
          const entries = readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line));
          assert(entries.every(row => row.executionId === record.id && row.workItemId === manifest.workItemId));
          report.workItem.phases = entries.map(row => row.phase);
        }
      }
      if (['completed','failed'].includes(report.workItem?.status)) break;
      await delay(500);
    }
    report.trackerRead = routes.has('GET /api/v4/projects/1/issues');
    if (report.workItem?.status === 'failed') {
      const worker = join(archive, 'dist-electron/execution-worker.js');
      const diagnostic = spawnSync(join(bundle, 'Contents/MacOS/AFK Control'), [worker, JSON.stringify({
        workItemId: `gitlab:${new URL(origin).host}/acme/api#1`, manifestPath: join(root, 'missing-manifest.json') })],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, cwd: work, timeout: 15000, encoding: 'utf8' });
      const stderr = diagnostic.stderr ?? '';
      report.workerControl = { missingManifest: true, exitCode: diagnostic.status,
        workerEntryNotFound: stderr.includes('execution-worker.js') && /Cannot find module|MODULE_NOT_FOUND/.test(stderr),
        reachedManifestValidation: /file does not exist/.test(stderr) && stderr.includes('missing-manifest.json') };
    }
    const sessions = join(agentDir, 'sessions');
    const files = existsSync(sessions) ? readdirSync(sessions, { recursive: true }).filter(name => name.endsWith('.jsonl')) : [];
    report.native = { sessions: files.length, matched: false };
    for (const file of files) {
      const rows = readFileSync(join(sessions,file),'utf8').trim().split('\n').map(line => JSON.parse(line));
      const messages = rows.map(row => row.message).filter(Boolean);
      if (rows[0].type !== 'session' || rows[0].cwd !== checkout) continue;
      for (const context of contexts) {
        const user = messages.findIndex(message => message.role === 'user' && JSON.stringify(message.content).includes(context));
        const reply = messages[user + 1];
        if (user < 0 || reply?.role !== 'assistant' || reply.provider !== 'local' || reply.model !== model || reply.stopReason !== 'stop') continue;
        const text = reply.content.filter(block => block.type === 'text').map(block => block.text).join('');
        if (text.includes(context) && reply.usage.totalTokens > 0) report.native = { sessions: files.length, matched: true,
          markerInContext: true, checkoutMatched: true, contextFilenameInPromptAndReply: true,
          replySha256: createHash('sha256').update(text).digest('hex'), inputTokens: reply.usage.input, outputTokens: reply.usage.output, totalTokens: reply.usage.totalTokens };
      }
    }
    report.scope = { entry: 'packaged Desktop / work item / start / create run', resultRequired: 'correlated native reply',
      tracker: 'synthetic loopback GitLab', git: 'temporary local bare repository', network: 'loopback only', agentTools: 'disabled',
      processIdentity: 'host ps start time for sandbox descendants', workflowLimitMs: 45000 };
    report.passed = report.trackerRead && report.native.matched && ['completed','failed'].includes(report.workItem?.status);
    if (ticket) {
      const eventDir = join(root,'.afk/events');
      const eventRows = readdirSync(eventDir).filter(name => name.endsWith('.jsonl')).flatMap(name => readFileSync(join(eventDir,name),'utf8').trim().split('\n').map(line => JSON.parse(line)));
      report.qaEvents = eventRows.map(row => row.data).filter(data => data?.kind?.startsWith('qa.')).map(data => ({ kind: data.kind, reasonCode: data.reasonCode, summary: data.summary?.replaceAll(root,'<scratch>').replace(/127\.0\.0\.1:\d+/g,'loopback').slice(0,350) }));
      report.routes = [...routes].sort();
      const logDir = join(root,'.afk/logs');
      report.checkoutChecks = readdirSync(logDir).filter(name => name.endsWith('.log')).flatMap(name => readFileSync(join(logDir,name),'utf8').trim().split('\n').flatMap(line => {
        let row;
        try { row = JSON.parse(line); } catch { return []; }
        return row.msg === 'QA worktree diagnostics' ? [{ phase: row.phase, status: row.diagnostics.status }] : [];
      }));
      report.scope.resultRequired = 'completed work item, committed answer and fresh native QA';
      report.scope.agentTools = ['read_ticket', 'create_answer (exclusive create)', 'read_answer','write_signal'];
      report.scope.workflowLimitMs = 180000;
      report.scope.agentPrompt = 'local tool guidance added for task / AC / QA; verdict supplied by Pi';
      const expectedBytes = expected + '\n';
      const digest = value => createHash('sha256').update(value).digest('hex');
      const branches = run('git', '--git-dir', bare, 'for-each-ref', '--format=%(refname)', 'refs/heads').split('\n');
      const commits = branches.filter(branch => branch !== 'refs/heads/main').flatMap(branch => {
        const file = spawnSync('git', ['--git-dir', bare, 'show', `${branch}:answer.txt`]);
        return file.status === 0 && file.stdout.toString() === expectedBytes ? [{ branch, commit: run('git', '--git-dir', bare, 'rev-parse', branch) }] : [];
      });
      report.artifact = { path: 'answer.txt', expected, sha256: digest(expectedBytes), checkoutMatches: !!checkout && existsSync(join(checkout,'answer.txt')) && readFileSync(join(checkout,'answer.txt'),'utf8') === expectedBytes, commits };
      report.native = { sessions: files.map(file => {
        const rows = readFileSync(join(sessions,file),'utf8').trim().split('\n').map(line => JSON.parse(line));
        const messages = rows.map(row => row.message).filter(Boolean);
        const replies = messages.filter(msg => msg.role === 'assistant');
        const results = messages.filter(msg => msg.role === 'toolResult');
        return { implementationCheckout: rows[0].cwd === checkout, qaCheckout: rows[0].cwd === join(checkout,'.worktrees/afk-backlog-1-qa'), local: replies.length > 0 && replies.every(msg => msg.provider === 'local' && msg.model === model),
          stopReasons: replies.map(msg => msg.stopReason), toolResults: results.map(msg => ({ name: msg.toolName, error: !!msg.isError })),
          readTicket: results.some(msg => msg.toolName === 'read_ticket' && !msg.isError && JSON.stringify(msg.content).includes(description)),
          readArtifact: results.some(msg => msg.toolName === 'read_answer' && !msg.isError && msg.content.some(block => block.text === expectedBytes)),
          qaPassSignal: replies.some(msg => msg.content.some(block => block.type === 'toolCall' && block.name === 'write_signal' && block.arguments?.kind === 'qa' && block.arguments?.result === 'PASS' && results.some(result => !result.isError && result.toolCallId === block.id))),
          unsupportedTools: replies.some(msg => /does not support tools/i.test(msg.errorMessage || '')) };
      }) };
      report.localChange = change ? { iid: change.iid, branch: change.source_branch, target: change.target_branch } : null;
      report.passed = report.trackerRead && report.workItem?.status === 'completed' && report.workItem.phases.includes('merge_ready') &&
        report.qaEvents.some(event => event.kind === 'qa.passed') && commits.some(row => row.branch === `refs/heads/${change?.source_branch}`) &&
        report.native.sessions.some(session => session.implementationCheckout && session.local && session.readTicket && session.toolResults.some(tool => tool.name === 'create_answer' && !tool.error)) &&
        report.native.sessions.some(session => session.qaCheckout && session.local && session.readArtifact && session.readTicket && session.qaPassSignal);
    }
    report.phase = 'observed';
  } catch (error) {
    report.failure = error.name;
  } finally {
    await app?.close();
    spawnSync('tmux', ['kill-server'], { env: process.env, timeout: 3000, stdio: 'ignore' });
    server.close();
    if (daemon && daemon.exitCode === null) { const stopped = once(daemon, 'exit'); daemon.kill(); const timer = setTimeout(() => daemon.kill('SIGKILL'), 2000); await stopped; clearTimeout(timer); }
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
