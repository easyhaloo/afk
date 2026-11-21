import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const proof = resolve(process.argv[2]);
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const formal = read(join(proof, 'formal.json'));
const extraction = read(join(proof, 'extraction.json'));
const candidate = extraction.candidates.find(entry => entry.id === formal.candidateId);
assert.equal(candidate.id, 'e1316adc38460632b234887bb4e15cc0c5d770ff33c1b4ba47bdddfc5818a584');
const archive = join(proof, 'release', 'afk-darwin-arm64.tar.gz');
const archiveDigest = hash(readFileSync(archive));
assert.equal(archiveDigest, '47e451118faf7d990d84ca713eeabe168fa5922c81a0d34823666ec7b5082e2f');
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tool-denial-')));
try {
  execFileSync('tar', ['-xzf', archive, '-C', scratch]);
  const cli = join(scratch, 'afk/dist/index.js');
  const runtime = join(scratch, 'afk/node_modules/@afk/runtime/dist/application/learning');
  const load = name => import(pathToFileURL(join(runtime, `${name}.js`)).href);
  const { canonicalLearningJson } = await load('requests');
  const { validateConfiguredLearningCandidate } = await load('validation-runtime');
  const { readProposalCatalog } = await load('proposal-catalog');
  const { prepareAssetProposal } = await load('proposals');
  const { prepareProposalExperiment } = await load('proposal-semantics');
  const originalConfig = join(extraction.home, 'asset-gate-QOTe2o/bindings/checkers.json');
  const config = read(originalConfig);
  const [checker] = config.checkers;
  assert.equal(hash(canonicalLearningJson(checker)), formal.checkerDigest);
  const grant = read(checker.executionAuthorizationFile);
  assert.equal(grant.checkerDigest, formal.checkerDigest);
  assert.equal(grant.revoked, false);
  assert.deepEqual(grant.allowed, { permissions: [], dependencies: [], sideEffects: 'none' });
  const catalog = readProposalCatalog({ scope: checker.scope, repositoryRoot: checker.repository.root,
    expectedCommit: formal.expectedCommit, ...checker.inventory });
  const prepared = prepareAssetProposal(candidate.proposal, catalog.inventory);
  const [saved] = checker.semantic.cases;
  const permission = prepared.checks.find(check => check.id === saved.checkId);
  assert.equal(hash(canonicalLearningJson(permission)), saved.checkDigest);
  const experiment = prepareProposalExperiment('tool', checker.asset.path, permission, saved.experiment, candidate.proposal.payload.inputSchema);
  assert.deepEqual(experiment, { status: 'unsupported', reason: 'control_experiment_unavailable' });
  assert.deepEqual(experiment, formal.permissionProbe);
  assert.equal(prepared.checks.length, 8);
  assert.equal(checker.semantic.cases.length, 1);
  const historical = read(join(proof, 'validation.json'));
  assert.notEqual(historical.candidateId, candidate.id);
  assert.equal(historical.candidateSha256, prepared.artifact.digest);

  const profile = join(scratch, 'profile');
  const directory = join(profile, '.afk/learning');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'candidates.sqlite');
  const source = join(extraction.home, '.afk/learning/candidates.sqlite');
  for (const suffix of ['-wal', '-journal']) assert.equal(existsSync(source + suffix), false);
  copyFileSync(source, file);
  const args = { scope: checker.scope, checkerId: checker.checkerId, candidateId: candidate.id, expectedVersion: candidate.version };
  let selections = 0;
  const unexpectedSelection = () => { selections++; throw new Error('Unexpected provider selection'); };
  const validate = configurationFile => validateConfiguredLearningCandidate(args, { file, homeDir: extraction.home,
    configurationFile, resolveProvider: unexpectedSelection, proposal: { resolveRepository: unexpectedSelection } });
  const active = await validate(originalConfig);
  assert.deepEqual(active, { status: 'blocked', code: 'insufficient_coverage' });
  const save = (name, data) => {
    const path = join(profile, name);
    writeFileSync(path, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
    return path;
  };
  checker.executionAuthorizationFile = join(profile, 'revoked.json');
  save('revoked.json', { ...grant, checkerDigest: hash(canonicalLearningJson(checker)), revoked: true });
  const privateConfig = save('checkers.json', config);
  const revoked = await validate(privateConfig);
  assert.deepEqual(revoked, { status: 'blocked', code: 'unauthorized' });
  assert.equal(selections, 0);
  const settings = save('settings.json', { enabled: true, dailyCalls: 0, validation: { configurationFile: privateConfig } });
  const options = { cwd: profile, encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH,
    HOME: profile, USERPROFILE: profile, XDG_CONFIG_HOME: join(profile, '.config'), NO_COLOR: '1' } };
  execFileSync(process.execPath, [cli, 'plugin', 'configure', 'learning.distiller', '--builtin', '--file', settings], options);
  const command = spawnSync(process.execPath, [cli, 'experience', 'validate', candidate.id, '--scope', args.scope,
    '--expected-version', String(args.expectedVersion), '--checker', args.checkerId, '--json'], options);
  assert.equal(command.status, 1);
  assert.deepEqual(JSON.parse(command.stdout), revoked);
  const after = JSON.parse(execFileSync(process.execPath, [cli, 'experience', 'inspect', candidate.id, '--scope', args.scope, '--json'], options));
  assert.equal(after.state, 'candidate');
  assert.equal(after.version, candidate.version);
  assert.equal(after.digest, candidate.digest);
  console.log(JSON.stringify({ base: '2aca5d6b', version: read(join(dirname(dirname(cli)), 'release.json')).version, archiveDigest,
    formalSha256: hash(readFileSync(join(proof, 'formal.json'))), candidateId: candidate.id, sourceDigest: prepared.artifact.digest,
    historicalCandidateId: historical.candidateId, checks: prepared.checks.map(({ id, kind }) => ({ id, kind })),
    configured: [saved.checkId], experiment, originalCLI: { exit: formal.exit, result: formal.result }, installedRuntime: { active, revoked, selections },
    revokedCLI: { exit: command.status, result: revoked, state: after.state, version: after.version } }, null, 2));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
