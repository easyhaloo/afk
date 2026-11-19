import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [historyArg, outputArg, releaseArg, imageArg] = process.argv.slice(2);
assert.ok(historyArg && outputArg && releaseArg && /^sha256:[0-9a-f]{64}$/.test(imageArg), 'Expected history, fresh output, installed release and immutable image ID');
const observerArg = new URL('./checker.mjs', import.meta.url);
const businessArg = new URL('./handoff.json', import.meta.url);
process.umask(0o077);
const history = realpathSync(historyArg);
mkdirSync(resolve(outputArg));
const output = realpathSync(outputArg);
const home = join(output, 'home');
const root = join(output, 'repository');
const learning = join(home, '.afk/learning');
const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), DOCKER_CONFIG: join(home, 'docker'),
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', PATH: '/usr/local/bin:/usr/bin:/bin',
  GIT_AUTHOR_DATE: '2026-11-19T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-19T00:00:00Z',
  AFK_LOG_DIR: join(output, 'logs'), AFK_EVENT_STORE_DIR: join(output, 'events') };
Object.assign(process.env, env);
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (name, value) => {
  const path = join(output, name);
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  return path;
};
const run = (program, args) => {
  const result = spawnSync(program, args, { cwd: root, env, encoding: 'utf8', timeout: args.includes('validate') ? 135_000 : 30_000 });
  if (result.error) throw result.error;
  assert.equal(result.signal, null);
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
};
const success = result => { assert.equal(result.status, 0, result.stderr); return result.stdout; };
const producer = join(history, 'producer-installed');
const proposal = json(join(producer, 'proposal.json'));
const installation = { mode: 'installed', binary: realpathSync(join(releaseArg, 'dist/index.js')),
  runtime: realpathSync(join(releaseArg, 'node_modules/@afk/runtime/dist')), version: json(join(releaseArg, 'release.json')).version };
assert.ok(installation.runtime.startsWith(realpathSync(releaseArg) + '/'));
assert.equal(installation.mode, 'installed');
const load = name => import(pathToFileURL(join(installation.runtime, `application/learning/${name}.js`)));
const { canonicalLearningJson } = await load('requests');
const { readProposalCatalog } = await load('proposal-catalog');
const { prepareAssetProposal } = await load('proposals');
const { buildEvidencePack } = await load('evidence');
const { validationConfigurationSchema, proposalExecutionGrantSchema } = await load('validation-configuration');
const { proposalSemanticConfigurationSchema } = await load('proposal-semantics');
const { PROPOSAL_VALIDATION_RUNTIME_REVISION: hostRuntimeRevision, PROPOSAL_VALIDATION_ADAPTER_REVISION: revision } = await load('proposal-validation-runtime');
const { CandidateStore } = await load('candidate-store');
const digest = value => sha(canonicalLearningJson(value));
const cli = (...args) => run(process.execPath, [installation.binary, ...args]);
mkdirSync(learning, { recursive: true });
copyFileSync(join(producer, 'producer-ledger/candidates.sqlite'), join(learning, 'candidates.sqlite'));
const scanRoots = { skills: 'skills', cli: 'cli', script: 'script', plugin: 'plugin' };
for (const directory of Object.values(scanRoots)) mkdirSync(join(root, directory), { recursive: true });
const asset = { ref: 'skill:reconcile-bags', path: 'skills/reconcile-bags/SKILL.md' };
const skillFile = join(root, asset.path);
mkdirSync(dirname(skillFile));
copyFileSync(join(producer, 'source/reconcile-bags/SKILL.md'), skillFile);
copyFileSync(businessArg, join(dirname(skillFile), 'handoff.json'));
const git = (...args) => success(run('git', ['-c', 'core.hooksPath=/dev/null', ...args]));
git('init', '--quiet', '--initial-branch=main');
git('add', '--', asset.path);
git('add', '--', 'skills/reconcile-bags/handoff.json');
git('-c', 'user.name=W11', '-c', 'user.email=w11@fixture.invalid', 'commit', '--quiet', '-m', 'Synthetic skill baseline');
const expectedCommit = git('rev-parse', 'HEAD');
assert.equal(expectedCommit, '0e642fc0a1996a186a9c2764cc43a4072a6591fc');
const remoteUrl = 'http://127.0.0.1/parcel.git';
{
  const bare = join(output, 'parcel.git');
  git('clone', '--bare', root, bare);
  env.GIT_CONFIG_GLOBAL = join(home, 'gitconfig');
  git('config', '--global', `url.${pathToFileURL(bare).href}.insteadOf`, remoteUrl);
}
const id = proposal.candidateId;
const scope = proposal.proposal.applicability.project;
const inspect = () => JSON.parse(success(cli('experience', 'inspect', id, '--scope', scope, '--json')));
assert.equal(id, '4cc64163ac59ad7f437307d06df67fd964b3ba3b7bc8ff7cfa622ac162663edf');
const before = inspect();
assert.equal(before.state, 'candidate');
assert.equal(before.version, 1);
assert.deepEqual(before.proposal, proposal.proposal);
const original = sha(readFileSync(skillFile));
const proposed = sha(readFileSync(join(producer, 'proposed/SKILL.md')));
mkdirSync(join(output, 'inventory'));
const manifest = save('inventory/inventory.json', { version: 1, scope, repositoryRoot: root, expectedCommit, scanRoots, tools: [], skills: [{
  name: 'reconcile-bags', description: '封袋对账（袋单核对）技能比对交接单和袋号，只读输出差异。', 'disable-model-invocation': false,
  'user-invocable': true, 'allowed-tools': ['Read'], 'disallowed-tools': ['Bash', 'Write'], scope, expectedCommit,
  resources: [{ path: 'handoff.json', digest: sha(readFileSync(businessArg)) }],
  digest: original, source: { root, file: skillFile } }] });
const inventory = { file: manifest, digest: sha(readFileSync(manifest)) };
const catalog = readProposalCatalog({ scope, repositoryRoot: root, expectedCommit, ...inventory });
const prepared = prepareAssetProposal(before.proposal, catalog.inventory);
assert.deepEqual(prepared.checks, proposal.checks);
assert.equal(prepared.artifact.originalDigest, original);
assert.equal(prepared.artifact.digest, proposed);
assert.equal(prepared.execution.autoInstall, false);
const runId = json(join(producer, 'extraction.json')).job.sourceRunId;
const allowedRoot = join(producer, 'producer-events');
const sources = [{ id: 'audit-1', kind: 'audit', allowedRoot, runId,
  path: join(allowedRoot, `${Buffer.from(runId).toString('base64url')}.jsonl`) }];
const evidence = await buildEvidencePack({ sources });
assert.equal(evidence.digest, before.evidenceDigest);
const adapter = 'skill-trace-v1';
const protocol = 'proposal-semantic-v1';
const outcomes = { normal: { missing: ['H-502'], extra: ['H-863'] }, refusal: 'refuse-before-read', recovery: 'request-missing-page' };
assert.deepEqual(prepared.checks.map(check => check.kind).sort(), Object.keys(outcomes).sort());
const cases = prepared.checks.map(check => ({ checkId: check.id, checkDigest: digest(check), experiment: {
  protocol, adapter, kind: check.kind, input: check.input,
  skillTrace: { checkerDigest: sha(readFileSync(observerArg)), reads: check.kind === 'normal'
    ? [{ path: '/business/handoff.json', digest: sha(readFileSync(businessArg)) }] : [] }, assertions: [
    { id: 'exit', source: 'exit-code', expected: check.kind === 'refusal' ? 1 : 0 },
    { id: 'answer', source: check.kind === 'normal' ? 'stdout-json' : 'stdout', expected: outcomes[check.kind] },
  ] } }));
const baseImageId = success(run('docker', ['--host', 'unix:///var/run/docker.sock', 'image', 'inspect', '--format', '{{.Id}}', imageArg]));
assert.equal(baseImageId, imageArg);
const checkerId = 'w11-skill-01';
const entry = { mode: 'repository-asset', scope, checkerId, version: revision, kind: 'skill',
  executionAuthorizationFile: join(output, 'grant.json'), repository: { providerId: 'multi-repository',
    repository: { url: 'parcel', ref: 'main' }, root, expectedCommit },
  asset, inventory, sandbox: { engine: 'docker', baseImageId }, semantic: { protocol, adapter, revision, cases }, evidence: [{ digest: evidence.digest, sources }] };
save('grant.json', proposalExecutionGrantSchema.parse({ version: 1, purpose: 'proposal-validation-execution', revoked: process.env.W11_REVOKED === '1',
  scope, checkerId, checkerVersion: revision, candidateId: id, candidateVersion: before.version, candidateDigest: before.digest,
  evidenceDigest: evidence.digest, checkerDigest: digest(entry), kind: 'skill', repository: entry.repository, asset,
  inventoryDigest: inventory.digest, sandbox: entry.sandbox, adapter: { id: adapter, revision, hostRuntimeRevision },
  allowed: { dependencies: [], permissions: [], sideEffects: 'none' }, limits: { timeoutMs: prepared.execution.timeoutMs, maxOutputBytes: 4096 } }));
const config = { version: 2, checkers: [entry] };
const configurationFile = save('checker.json', config);
const plugin = save('distiller.json', { enabled: true, dailyCalls: 0, validation: { configurationFile } });
success(cli('plugin', 'configure', 'repository.multi-repository', '--builtin', '--file', save('repository.json', {
  repositories: [{ name: 'parcel', path: root, baseBranch: 'main', remoteUrl, leaseKey: 'github:w11/parcel' }], managed: { workspaceRoot: join(output, 'managed') } })));
success(cli('plugin', 'configure', 'learning.distiller', '--builtin', '--file', plugin));
const parsed = validationConfigurationSchema.safeParse(config);
const validate = cli('experience', 'validate', id, '--scope', scope, '--expected-version', String(before.version), '--checker', checkerId, '--json');
const after = inspect();
const ledger = new CandidateStore({ file: join(learning, 'candidates.sqlite') });
let validationReceipt;
try { validationReceipt = ledger.getValidation(id) ?? null; } finally { ledger.close(); }
const issues = parsed.success ? [] : parsed.error.issues.map(({ path, message }) => ({ path, message }));
const normal = cases.find(entry => entry.experiment.kind === 'normal');
const executionContract = proposalSemanticConfigurationSchema.safeParse(normal.experiment);
const executionSchemaIssues = executionContract.success ? [] : executionContract.error.issues.map(({ path, message }) => ({ path, message }));
save('receipt.json', { installation, cliDigest: sha(readFileSync(installation.binary)), candidateId: id, original, proposed, evidenceDigest: evidence.digest,
  expectedCommit, baseImageId, cases: cases.map(({ checkId, checkDigest }) => ({ checkId, checkDigest })), issues, checkerProtocol: entry.semantic.protocol,
  executionSchemaIssues, validate,
  before: { state: before.state, version: before.version }, after: { state: after.state, version: after.version }, sameCandidate: canonicalLearningJson(before) === canonicalLearningJson(after), validationReceipt });
assert.deepEqual(issues, []);
assert.deepEqual(executionSchemaIssues, []);
if (validate.status === 0) {
  assert.equal(after.state, 'validated');
  assert.ok(validationReceipt);
} else {
  assert.equal(JSON.parse(validate.stdout).status, 'blocked');
  assert.deepEqual(before, after);
  assert.equal(validationReceipt, null);
}
process.exitCode = validate.status;
