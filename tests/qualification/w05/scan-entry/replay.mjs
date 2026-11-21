import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isolated } from '../scan-seatbelt.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const proof = resolve(process.argv[2]);
const requestedProfile = resolve(process.argv[3]);
const profile = join(realpathSync(dirname(requestedProfile)), basename(requestedProfile));
const frozen = read(new URL('../tool-denial/candidate.json', import.meta.url));
const extraction = read(join(proof, 'extraction.json'));
const candidate = extraction.candidates.find(entry => entry.id === frozen.candidateId);
const draft = readFileSync(new URL('scan-manifest.mjs', import.meta.url), 'utf8');
const cases = read(new URL('checker-cases.json', import.meta.url));
const formal = read(join(proof, 'formal.json'));
assert.equal(sha(readFileSync(join(proof, 'formal.json'))), frozen.formalSha256);
const archive = join(proof, 'release/afk-darwin-arm64.tar.gz');
assert.equal(sha(readFileSync(archive)), frozen.archiveDigest);
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'parcel-entry-')));
try {
  execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', scratch], { env: { LC_ALL: 'C' } });
  const cli = join(scratch, 'afk/dist/index.js');
  const { load } = createRequire(cli)('js-yaml');
  const [plugin] = load(readFileSync(join(extraction.home, '.afk/plugins.yml'), 'utf8')).plugins;
  assert.equal(plugin.id, 'learning.distiller');
  assert.equal(plugin.config.dailyCalls, 0);
  const configuration = read(plugin.config.validation.configurationFile);
  const [checker] = configuration.checkers;
  const grant = read(checker.executionAuthorizationFile);
  const loadRuntime = path => import(pathToFileURL(join(scratch, `afk/node_modules/@afk/runtime/dist/${path}.js`)));
  const learning = file => loadRuntime(`application/learning/${file}`);
  const { canonicalLearningJson } = await learning('requests');
  const digest = value => sha(canonicalLearningJson(value));
  assert.equal(digest(checker), formal.checkerDigest);
  assert.equal(grant.checkerDigest, digest(checker));
  assert.equal(grant.candidateDigest, candidate.digest);
  assert.equal(sha(candidate.proposal.payload.source), frozen.sourceDigest);
  assert.equal(grant.revoked, false);
  assert.deepEqual(grant.allowed, { permissions: [], dependencies: [], sideEffects: 'none' });
  mkdirSync(profile, { mode: 0o700 });
  const directory = join(profile, '.afk/learning');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'candidates.sqlite');
  for (const name of ['candidates.sqlite', 'distillation-queue.sqlite']) {
    const source = join(extraction.home, '.afk/learning', name);
    for (const suffix of ['-wal', '-journal']) assert.equal(existsSync(source + suffix), false);
    copyFileSync(source, join(directory, name));
  }
  const jsonFile = (name, value) => {
    const path = join(profile, name);
    writeFileSync(path, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    return path;
  };
  const invoke = (args, exit = 0) => {
    const run = spawnSync(process.execPath, [cli, ...args], { cwd: profile, timeout: 30000, encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: profile, USERPROFILE: profile, XDG_CONFIG_HOME: join(profile, '.config') } });
    assert.equal(run.status, exit, run.stderr);
    return run.stdout;
  };
  const configure = settings => invoke(['plugin', 'configure', plugin.id, '--builtin', '--file', settings]);
  configure(jsonFile('original-settings.json', plugin.config));
  const scope = ['--scope', extraction.scope];
  const inspect = () => JSON.parse(invoke(['experience', 'inspect', candidate.id, ...scope, '--json']));
  const before = inspect();
  assert.equal(before.digest, candidate.digest);
  const correction = join(profile, 'correction.txt');
  writeFileSync(correction, `Revise the scan-manifest tool source to the following ES module. Preserve the frozen tests, input/output schemas, permissions, dependencies, timeout and side effects. Use the exported function from the process entry point.\n\n${draft}`, { mode: 0o600 });
  const queued = JSON.parse(invoke(['experience', 'correct', candidate.id, ...scope, '--expected-version', '1', '--file', correction, '--json']));
  const { CandidateStore } = await learning('candidate-store');
  const ledger = new CandidateStore({ file });
  let correctionEvidence;
  try {
    const request = ledger.getRequest(queued.jobId);
    assert.equal(request.request.reason, 'correction');
    const pack = ledger.getEvidencePack(request.request.evidenceDigest);
    const document = JSON.parse(pack.entries[0].content);
    assert.equal(document.target.candidateDigest, candidate.digest);
    assert.equal(document.correction, readFileSync(correction, 'utf8').trim());
    correctionEvidence = pack.digest;
  } finally { ledger.close(); }
  const { LearningWorker } = await learning('worker');
  const { ClaudeCodeProvider } = await loadRuntime('domain/agents/claude-code');
  const worker = new LearningWorker({ directory, enabled: plugin.config.enabled, dailyCalls: plugin.config.dailyCalls, provider: new ClaudeCodeProvider() });
  let state;
  try { state = await worker.runOnce({ scope: queued.scope, requestKey: queued.jobId }); }
  finally { await worker.close(); }
  assert.equal(state.job.reasonCode, 'budget_exhausted');
  assert.deepEqual(state.job.attempts, []);
  assert.deepEqual(state.candidates, []);
  assert.deepEqual(inspect(), before);

  const { readProposalCatalog } = await learning('proposal-catalog');
  const { prepareAssetProposal } = await learning('proposals');
  const { prepareProposalExperiment } = await learning('proposal-semantics');
  const { validationConfigurationSchema } = await learning('validation-configuration');
  const { validateConfiguredLearningCandidate } = await learning('validation-runtime');
  const catalog = readProposalCatalog({ scope: checker.scope, repositoryRoot: checker.repository.root, expectedCommit: formal.expectedCommit, ...checker.inventory });
  const prepared = prepareAssetProposal(candidate.proposal, catalog.inventory);
  const proposal = structuredClone(candidate.proposal);
  proposal.payload.source = draft;
  const revised = prepareAssetProposal(proposal, catalog.inventory);
  assert.deepEqual(revised.checks, prepared.checks);
  const target = { scope: checker.scope, checkerId: checker.checkerId, candidateId: candidate.id, expectedVersion: 1 };
  const originalGate = await validateConfiguredLearningCandidate(target, { file, homeDir: extraction.home, configurationFile: plugin.config.validation.configurationFile });
  assert.deepEqual(originalGate, formal.result);
  assert.deepEqual(checker.semantic.cases.map(entry => entry.checkId), ['control-permission']);
  checker.semantic.cases.push(...cases);
  validationConfigurationSchema.parse(configuration);
  const checkerDigest = digest(checker);
  assert.notEqual(checkerDigest, grant.checkerDigest);
  const checkerFile = jsonFile('checkers.json', configuration);
  configure(jsonFile('revised-settings.json', { ...plugin.config, validation: { configurationFile: checkerFile } }));
  const changedCheckerGate = JSON.parse(invoke(formal.command, 1));
  assert.deepEqual(changedCheckerGate, { status: 'blocked', code: 'unauthorized' });
  assert.deepEqual(inspect(), before);

  const editions = { original: execFileSync('/usr/bin/git', ['-C', checker.repository.root, 'show', `${formal.expectedCommit}:${checker.asset.path}`]),
    frozenCandidate: prepared.artifact.content, requestedRevision: draft };
  assert.equal(sha(editions.original), prepared.artifact.originalDigest);
  for (const [name, bytes] of Object.entries(editions)) {
    mkdirSync(join(scratch, name));
    writeFileSync(join(scratch, name, 'scan-manifest.mjs'), bytes, { mode: 0o400 });
  }
  const observations = [];
  for (const entry of cases) {
    const check = revised.checks.find(check => check.id === entry.checkId);
    assert.equal(digest(check), entry.checkDigest);
    const experiment = prepareProposalExperiment('tool', checker.asset.path, check, entry.experiment, proposal.payload.inputSchema);
    assert.equal(experiment.status, 'prepared');
    const [runtime, path, raw] = experiment.experiment.argv;
    assert.deepEqual([runtime, path], ['node', '/workspace/script/scan-manifest.mjs']);
    const results = {};
    for (const edition of Object.keys(editions)) {
      const cwd = join(scratch, edition);
      const result = await isolated(cwd, [join(cwd, 'scan-manifest.mjs'), raw], entry.experiment.control);
      assert.equal(result.signal, null);
      if (edition !== 'requestedRevision') assert.deepEqual([result.exit, result.stdout, result.stderr], [0, '', '']);
      else if (check.kind === 'refusal') assert.deepEqual([result.exit, result.stdout, result.stderr], [1, '', check.expected]);
      else {
        assert.equal(result.exit, 0);
        assert.equal(result.stderr, '');
        const expected = revised.checks.find(check => check.kind === 'normal' && check.input === raw).expected;
        assert.deepEqual(JSON.parse(result.stdout), JSON.parse(expected));
      }
      if (entry.experiment.control) assert.equal(result.controlSent, false);
      results[edition] = result;
    }
    observations.push({ id: check.id, raw, results });
  }
  const cwd = join(scratch, 'requestedRevision');
  const guards = [];
  for (const [args, expected] of [[[], 'error: expected one JSON argument'], [['null','null'], 'error: expected one JSON argument'],
    [['{'], 'error: invalid JSON'], [['{}'], 'error: input must be a string']]) {
    const result = await isolated(cwd, [join(cwd, 'scan-manifest.mjs'), ...args]);
    assert.deepEqual([result.exit, result.signal, result.stdout, result.stderr], [1, null, '', expected]);
    guards.push({ args, result });
  }
  const imported = await isolated(cwd, ['--input-type=module', '-e', "import {checkManifest} from './scan-manifest.mjs'; process.stdout.write(JSON.stringify(checkManifest('')));"]);
  assert.deepEqual([imported.exit, imported.signal, imported.stderr, JSON.parse(imported.stdout)], [0, null, '', { checked: 1, invalidLines: [1] }]);
  console.log(JSON.stringify({ version: frozen.version, archiveSha256: frozen.archiveDigest, originalFormalSha256: frozen.formalSha256,
    queued, correctionEvidence, dailyCalls: plugin.config.dailyCalls, job: { status: state.job.status, reason: state.job.reasonCode, attempts: state.job.attempts, newCandidates: state.candidates },
    originalCandidate: { id: candidate.id, digest: before.digest, version: before.version, state: before.state }, sourceDigests: Object.fromEntries(Object.entries(editions).map(([name,bytes]) => [name,sha(bytes)])),
    originalGate, originalCheckerDigest: grant.checkerDigest, checkerDigest, changedCheckerGate, preparedCases: cases.map(entry => entry.checkId),
    assurance: 'diagnostic-only / darwin-seatbelt', observations, guards, imported }, null, 2));
} finally { rmSync(scratch, { recursive: true, force: true }); }
