import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../../../../", import.meta.url));
const loader = pathToFileURL(path.join(repository, "node_modules/tsx/dist/loader.mjs")).href;
const source = (file: string) => pathToFileURL(path.join(repository, file)).href;
const storeModule = source("packages/runtime/src/application/learning/candidate-store.ts");

type FixtureMetadata = {
  root: string;
  home: string;
  workspace: string;
  vault: string;
  file: string;
  scope: string;
  requestKey: string;
  candidateId: string;
  candidateDigest: string;
  evidenceDigest: string;
  checkerId: string;
  pluginId: string;
  extension: string;
  authorityFile: string;
  callsFile: string;
  configurationFile: string;
  authorizationFile: string;
  wikiScript: string;
};

export type LearningLedger = {
  candidate: { id: string; state: string; version: number; digest: string; evidenceDigest: string };
  receipt: { candidateId: string; candidateVersion: number; validatedVersion: number; candidateDigest: string;
    evidenceDigest: string; passed: boolean; validatorVersion: string } | null;
  publications: { key: string; phase: string; candidateId: string; candidateVersion: number }[];
};

const seedScript = `
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CandidateStore } from ${JSON.stringify(storeModule)};
import { buildEvidencePack } from ${JSON.stringify(source("packages/runtime/src/application/learning/evidence.ts"))};
import { reconcileDistillationSources } from ${JSON.stringify(source("packages/runtime/src/application/learning/intake.ts"))};
import { knowledgeFixture } from ${JSON.stringify(source("packages/runtime/src/application/learning/knowledge.fixture.spec.ts"))};
import { JsonlEventStore } from ${JSON.stringify(source("packages/runtime/src/infrastructure/observability/jsonl-event-store.ts"))};
const fixture = knowledgeFixture();
fixture.store.close();
const lesson = process.argv[1] === 'lesson';
const live = process.argv[3] === 'claude';
const home = process.env.HOME;
const workspace = join(process.env.TMPDIR, 'workspace');
const targetRoot = join(fixture.root, 'authority');
const extension = join(fixture.root, 'checker-package');
for (const directory of [join(workspace, '.afk'), targetRoot, extension]) mkdirSync(directory, { recursive: true });
const scope = process.argv[2] ?? fixture.policy.scope;
fixture.policy.scope = scope;
fixture.persistGrant();
const workItemId = scope + '#42';
const events = new JsonlEventStore({ root: process.env.AFK_EVENT_STORE_DIR });
const policy = { targetRef: 'wiki:approval', subject: 'approval', rule: 'Approve before publishing', version: 'abc' };
const publish = approved => approved ? 'published' : 'denied';
const observed = { withoutApproval: publish(false), withApproval: publish(true) };
assert.deepEqual(observed, { withoutApproval: 'denied', withApproval: 'published' });
const approval = { kind: 'effect.completed', effectKind: 'release.approval', idempotencyKey: 'approval-source',
  outcome: 'succeeded', summary: JSON.stringify({ ...policy, ...observed }) };
const history = live ? [{ kind: 'qa.started' }, approval, { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' }]
  : [{ kind: 'agent.session_recorded', sessionId: 'approval-session' }];
await events.append(history.map((data, index) => ({ id: 'approval-event-' + (index + 1), schemaVersion: 1, type: data.kind,
  occurredAt: '2026-11-11T00:00:00Z', correlationId: 'approval-source',
  context: { runId: 'approval-source', traceId: 'approval-trace', workItemId,
    profileId: 'default', attempt: 1, actor: { kind: 'system', id: 'desktop-e2e' } },
  data })));
const audit = { id: 'audit-1', kind: 'audit', path: events.pathFor('approval-source'),
  allowedRoot: process.env.AFK_EVENT_STORE_DIR, runId: 'approval-source' };
const file = join(home, '.afk', 'learning', 'candidates.sqlite');
if (live) {
  mkdirSync(home, { recursive: true });
  const capture = await reconcileDistillationSources({ directory: dirname(file), homeDir: home, eventRoot: events.root,
    scope, runId: 'approval-source' });
  assert.deepEqual(capture.blocked, []);
  assert.equal(capture.submitted, 1);
  assert.equal(capture.requestKeys.length, 1);
}
const store = new CandidateStore({ file });
let candidate, requestKey, pack;
try {
  if (live) {
    const requests = store.listRequests();
    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.equal(request.request.reason, 'completed');
    assert.deepEqual(store.getScanRequestKeys({ scope, runId: 'approval-source', analyzerVersion: request.request.analyzerVersion }), [request.key]);
    requestKey = request.key;
    pack = store.getEvidencePack(request.request.evidenceDigest);
  } else {
    pack = await buildEvidencePack({ sources: [audit] });
    const request = store.submitRequest({ request: { version: 1, scope, sourceId: 'run:approval-source',
      sourceRunId: 'approval-source', workItemId, evidenceDigest: pack.digest, analyzerVersion: '1', reason: 'import' },
      evidence: pack.entries.map(entry => entry.ref) }, pack);
    requestKey = request.key;
    const proposal = lesson ? { ...fixture.candidate.proposal, kind: 'lesson', payload: {
      trigger: 'Publication started before approval', rootCause: 'The approval guard was missing', rootCauseStatus: 'confirmed',
      attempts: ['Require approval before publication'], fix: 'Check approval before publishing',
      prevention: ['Keep an independent approval regression'],
    } } : fixture.candidate.proposal;
    const completed = store.completeRequest(request.key, { version: 1, warnings: [],
      candidates: [{ ...proposal, applicability: { ...proposal.applicability, project: scope },
        evidenceIds: pack.entries.map(entry => entry.ref.id) }] });
    candidate = store.getCandidate(completed.candidateIds[0]);
    assert.equal(candidate.state, 'candidate');
    assert.equal(candidate.version, 1);
    assert.equal(store.getValidation(candidate.id), undefined);
  }
} finally { store.close(); }
assert.equal(pack.completeness, 'complete');
const identity = { scope, checkerId: 'approval-rules', providerId: 'approval-oracle', version: '1' };
const authorityFile = join(targetRoot, 'approval.json');
const callsFile = join(fixture.root, 'checker-calls.jsonl');
const authority = pack.entries.filter(entry => !live || entry.position.auditSequence === 2).map(entry => entry.ref.locator);
assert.equal(authority.length, 1);
writeFileSync(authorityFile, JSON.stringify({ subject: policy.subject, rule: policy.rule,
  authority }), { mode: 0o600 });
writeFileSync(callsFile, '', { mode: 0o600 });
const configurationFile = join(fixture.root, 'checkers.json');
writeFileSync(configurationFile, JSON.stringify({ version: 1, checkers: [{ ...identity,
  ...(lesson ? { allowLessonValidation: true } : {}),
  authorizationFile: fixture.authorizationFile, target: { ref: 'wiki:approval', root: targetRoot, path: 'approval.json' },
  ...(live ? {} : { evidence: [{ digest: pack.digest, sources: [audit] }] }) }] }), { mode: 0o600 });
const manifest = { id: 'verification.approval-desktop-e2e', version: '1.0.0', apiVersion: 1,
  provides: ['verification.provider'], trusted: true, entry: 'index.js',
  configSchema: { type: 'object', additionalProperties: false, required: ['authorityFile', 'callsFile'],
    properties: { authorityFile: { type: 'string', minLength: 1 }, callsFile: { type: 'string', minLength: 1 } } } };
writeFileSync(join(extension, 'package.json'), JSON.stringify({ name: 'approval-desktop-e2e', version: '1.0.0', type: 'module' }));
writeFileSync(join(extension, 'plugin.json'), JSON.stringify(manifest));
writeFileSync(join(extension, 'index.js'), \`
  import { appendFileSync, readFileSync } from 'node:fs';
  const manifest = \$\{JSON.stringify(manifest)\};
  const identity = \$\{JSON.stringify(identity)\};
  export default ({ configuration }) => ({ manifest, activate(context) {
    context.registerVerificationProvider(identity.providerId, {
      id: identity.providerId,
      capabilities: { 'test-execution': true, 'static-analysis': false, 'custom-script': false },
      async doctor() { return [{ check: 'learning-validation-v1', ok: true, detail: JSON.stringify(identity) }]; },
      async verify(request) {
        appendFileSync(configuration.callsFile, JSON.stringify({ operation: 'verify', pid: process.pid }) + '\\\\n');
        const observed = JSON.parse(readFileSync(configuration.authorityFile, 'utf8'));
        const actual = new Map([['fact.subject', observed.subject], ['fact.rule', observed.rule], ['fact.authority', observed.authority]]);
        const envelope = JSON.parse(request.target);
        return { passed: true, durationMs: 1, output: JSON.stringify({ protocol: 'learning-validation-v1', binding: envelope.binding,
          assertions: envelope.assertions.map(assertion => ({ ...assertion, actual: actual.get(assertion.node), status: 'observed' })) }) };
      }
    });
  } });
\`);
console.log(JSON.stringify({ root: fixture.root, home, workspace, vault: fixture.vault, file, scope, requestKey,
  candidateId: candidate?.id, candidateDigest: candidate?.digest, evidenceDigest: pack.digest,
  checkerId: identity.checkerId, pluginId: manifest.id, extension, authorityFile, callsFile,
  configurationFile, authorizationFile: fixture.authorizationFile, wikiScript: fixture.wikiScript }));
`;

export async function createLearningFixture(kind: 'fact' | 'lesson' = 'fact', scopeOverride?: string, analysis: boolean | 'hold' = false) {
  const temporary = mkdtempSync(path.join(realpathSync(tmpdir()), "afk-desktop-learning-"));
  const home = path.join(temporary, "home");
  const env: Record<string, string> = {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"),
    TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    PATH: ["/usr/bin", "/bin"].join(path.delimiter),
    AFK_EVENT_STORE_DIR: path.join(temporary, "events"), AFK_LOG_DIR: path.join(temporary, "logs"),
    NO_COLOR: "1", LANG: "C", LC_ALL: "C",
  };
  const node = async (script: string, args: string[] = []) => {
    const result = await execute(process.execPath, ["--import", loader, "--input-type=module", "--eval", script, ...args],
      { cwd: repository, env, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(result.stdout);
  };
  try {
    const bin = path.join(temporary, "bin");
    mkdirSync(bin, { mode: 0o700 });
    const dependencies: Record<string, { executable: string; version: string }> = {};
    for (const tool of ["python3", "rg", ...(analysis === true ? ["claude"] : [])]) {
      try {
        const found = await execute("/usr/bin/which", [tool], {
          env: { ...env, PATH: process.env.PATH ?? "" }, timeout: 5_000,
        });
        const selected = found.stdout.trim();
        if (!path.isAbsolute(selected)) throw new Error("Dependency discovery did not return an absolute path.");
        const executable = realpathSync(selected);
        if (!statSync(executable).isFile()) throw new Error("Dependency is not a regular file.");
        accessSync(executable, constants.X_OK);
        const args = tool === "python3"
          ? ["-I", "-c", "import sys; assert sys.version_info >= (3, 10), 'Python 3.10+ required'; print(sys.version.split()[0])"]
          : ["--version"];
        const result = await execute(executable, args, { env, timeout: 5_000 });
        const version = result.stdout.trim().split("\n")[0]!;
        const versionPattern = tool === "python3" ? /^3\.\d+\.\d+/ : tool === "claude" ? /^\d+\.\d+\.\d+/ : /^ripgrep \d+\.\d+/;
        if (!versionPattern.test(version)) {
          throw new Error(`Unrecognized ${tool} version: ${version}`);
        }
        symlinkSync(executable, path.join(bin, tool));
        dependencies[tool] = { executable, version };
      } catch (error) {
        throw new Error(`Desktop learning E2E dependency doctor failed for ${tool}; install it on the runner PATH.`, { cause: error });
      }
    }
    env.PATH = [bin, "/usr/bin", "/bin"].join(path.delimiter);
    if (analysis === true) {
      env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? path.join(userInfo().homedir, '.claude');
      if (process.env.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    const launches = path.join(temporary, 'analysis-launches.ndjson');
    if (analysis === 'hold') {
      writeFileSync(launches, '', { mode: 0o600 });
      writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
        const { appendFileSync } = require('node:fs');
        if (process.argv.includes('--help')) {
          console.log('--safe-mode --tools --permission-mode --permission-prompts --strict-mcp-config --mcp-config --disable-slash-commands --setting-sources --settings --no-session-persistence --no-chrome --session-id --system-prompt');
        } else if (process.argv.includes('--version')) {
          console.log('2.1.0');
        } else if (process.argv.includes('--print') && process.argv.includes('--session-id')) {
          appendFileSync(${JSON.stringify(launches)}, JSON.stringify({ pid: process.pid, guardPid: process.ppid, directory: process.cwd() }) + '\\n');
          setTimeout(() => process.exit(90), 45_000);
        }
      `, { mode: 0o700 });
    }
    const binary = path.resolve(process.env.AFK_E2E_CLI_ENTRY ?? path.join(repository, "apps/cli/dist/index.js"));
    if (!existsSync(binary)) throw new Error(`CLI entry not found: ${binary}. Build the CLI or set AFK_E2E_CLI_ENTRY.`);
    if (analysis && !scopeOverride) throw new Error('Managed analysis needs an explicit project scope.');
    const seed = await node(seedScript, analysis ? [kind, scopeOverride!, 'claude'] : scopeOverride === undefined ? [kind] : [kind, scopeOverride]);
    const fixture = seed as FixtureMetadata;
    const command = (...args: string[]) =>
      execute(process.execPath, [binary, ...args], { cwd: fixture.workspace, env, timeout: 15_000 });
    let sequence = 0;
    const configure = async (id: string, configuration: unknown, builtin: boolean) => {
      const file = path.join(temporary, `configuration-${sequence++}.json`);
      writeFileSync(file, JSON.stringify(configuration), { mode: 0o600 });
      await command("plugin", "configure", id, ...(builtin ? ["--builtin"] : []), "--file", file);
    };
    await command("plugin", "install", fixture.extension);
    const installed = readFileSync(path.join(home, ".afk", "plugins", fixture.pluginId, "install.json"), "utf8");
    if (!installed.includes(fixture.pluginId)) throw new Error("The real checker install receipt is missing.");
    await configure(fixture.pluginId, { authorityFile: fixture.authorityFile, callsFile: fixture.callsFile }, false);
    await configure("learning.distiller", { enabled: true, dailyCalls: analysis === 'hold' ? 2 : analysis ? 1 : 0,
      validation: { configurationFile: fixture.configurationFile },
      knowledge: { wikiScript: fixture.wikiScript, grants: [fixture.authorizationFile] } }, true);
    return {
      ...fixture, temporary, env, dependencies,
      analysisLaunches: () => readFileSync(launches, 'utf8').trim().split('\n').filter(Boolean)
        .map(line => JSON.parse(line) as { pid: number; guardPid: number; directory: string }),
      queueOwners: () => node(`
        import { DatabaseSync } from 'node:sqlite';
        const database = new DatabaseSync(process.argv[1], { readOnly: true });
        try {
          console.log(JSON.stringify(database.prepare('SELECT pid FROM trigger_queue_owner').all().map(row => row.pid)));
        } finally { database.close(); }
      `, [path.join(path.dirname(fixture.file), 'distillation-queue.sqlite')]) as Promise<number[]>,
      runWorkerFromCli: () => command('experience', 'worker', 'once', '--scope', fixture.scope, '--request', fixture.requestKey, '--json'),
      jobsFromCli: async () => {
        const { stdout } = await command("experience", "jobs", "--scope", fixture.scope, "--json");
        return JSON.parse(stdout) as { jobId: string; scope: string; status: string; reasonCode?: string;
          attempts: { callId: string; ownerPid: number; status: string; errorCode?: string }[] }[];
      },
      readProcessedFact: async () => {
        const candidate = await node(`
          import assert from 'node:assert/strict';
          import { CandidateStore } from ${JSON.stringify(storeModule)};
          const store = new CandidateStore({ file: process.argv[1] });
          try {
            const { candidateIds } = store.getProcessingReceipt(process.argv[2]);
            assert.equal(candidateIds.length, 1);
            const [candidateId] = candidateIds;
            const candidate = store.getCandidate(candidateId);
            assert.equal(candidate.proposal.kind, 'fact');
            console.log(JSON.stringify({ candidateId, candidateDigest: candidate.digest, evidenceDigest: candidate.evidenceDigest }));
          } finally { store.close(); }
        `, [fixture.file, fixture.requestKey]) as Pick<FixtureMetadata, 'candidateId' | 'candidateDigest' | 'evidenceDigest'>;
        Object.assign(fixture, candidate);
        return candidate;
      },
      submitCorrectionFromCli: async (correction: string) => {
        const file = path.join(temporary, "cli-correction.txt");
        writeFileSync(file, correction, { mode: 0o600 });
        const { stdout } = await command("experience", "correct", fixture.candidateId, "--scope", fixture.scope,
          "--expected-version", "1", "--file", file, "--json");
        return JSON.parse(stdout) as { jobId: string; scope: string; candidateId: string; candidateVersion: number };
      },
      processCorrection: (jobId: string) => node(`
        import { dirname } from 'node:path';
        import { CandidateStore } from ${JSON.stringify(storeModule)};
        import { LearningWorker } from ${JSON.stringify(source("packages/runtime/src/application/learning/worker.ts"))};
        import { ClaudeCodeProvider } from ${JSON.stringify(source("packages/runtime/src/domain/agents/claude-code.ts"))};
        const [file, scope, requestKey] = process.argv.slice(1);
        let calls = 0;
        for (let pass = 0; pass < 2; pass++) {
          const worker = new LearningWorker({ directory: dirname(file), enabled: true, dailyCalls: 2,
            provider: new ClaudeCodeProvider(), analyze: async () => {
              calls++;
              return { analysisRunId: 'correction-test-analysis', output: { type: 'goal_complete',
                distillation: { version: 1, warnings: [], candidates: [] } } };
            } });
          try { await worker.runOnce({ scope, requestKey }); } finally { await worker.close(); }
        }
        const store = new CandidateStore({ file });
        try {
          const attempts = store.listAnalysisAttempts(requestKey);
          const reservedCalls = [...new Set(attempts.map(attempt => attempt.day))]
            .reduce((total, day) => total + store.getModelCallCount(day), 0);
          console.log(JSON.stringify({ calls, attempts: attempts.map(attempt => attempt.status), reservedCalls,
            receipt: store.getProcessingReceipt(requestKey) }));
        } finally { store.close(); }
      `, [fixture.file, fixture.scope, jobId]),
      inspect: () => node(`
        import { CandidateStore } from ${JSON.stringify(storeModule)};
        const store = new CandidateStore({ file: process.argv[1] });
        try { console.log(JSON.stringify({ candidate: store.getCandidate(process.argv[2]),
          receipt: store.getValidation(process.argv[2]) ?? null, publications: store.listPublications() })); }
        finally { store.close(); }
      `, [fixture.file, fixture.candidateId]) as Promise<LearningLedger>,
      invalidateSource: () => node(`
        import { CandidateStore } from ${JSON.stringify(storeModule)};
        const store = new CandidateStore({ file: process.argv[1] });
        try {
          const candidate = store.getCandidate(process.argv[2]);
          store.invalidateRequestSource(candidate.requestKey);
          console.log(JSON.stringify(store.getCandidate(candidate.id)));
        } finally { store.close(); }
      `, [fixture.file, fixture.candidateId]),
      gatherKnowledge: () => node(`
        import { KnowledgeContextProvider } from ${JSON.stringify(source("packages/runtime/src/application/learning/knowledge-runtime.ts"))};
        const provider = new KnowledgeContextProvider({ file: process.argv[1], recoveryDirectory: process.argv[2],
          config: { wikiScript: process.argv[3], grants: [process.argv[4]] },
          validationConfigurationFile: process.argv[6], homeDir: process.env.HOME });
        console.log(JSON.stringify(await provider.gather({ scope: process.argv[5], prompt: 'Approval',
          applicability: { version: 'abc' }, target: { project: process.argv[5], conditions: {} } })));
      `, [fixture.file, path.join(home, ".afk", "learning", "publications"), fixture.wikiScript, fixture.authorizationFile,
        fixture.scope, fixture.configurationFile]) as Promise<{ origin: string; content: string }[]>,
      calls: () => readFileSync(fixture.callsFile, "utf8").split("\n").filter(Boolean)
        .map(line => JSON.parse(line) as { operation: string; pid: number }),
      setObservedRule: (rule: string) => {
        const authority = JSON.parse(readFileSync(fixture.authorityFile, "utf8"));
        writeFileSync(fixture.authorityFile, JSON.stringify({ ...authority, rule }));
      },
      navigation: () => ["00-总览.md", "知识/入口.md"].map(file => readFileSync(path.join(fixture.vault, file), "utf8")),
      asset: path.join(fixture.vault, "知识/Approval.md"),
      cleanup: () => rmSync(temporary, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export type LearningFixture = Awaited<ReturnType<typeof createLearningFixture>>;
