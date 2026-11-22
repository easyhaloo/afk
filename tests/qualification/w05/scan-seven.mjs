import assert from 'node:assert/strict';
import { isolated } from './scan-seatbelt.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const proof = resolve(process.argv[2]);
const frozen = read(fileURLToPath(new URL('./tool-denial/candidate.json', import.meta.url)));
const receipt = read(join(proof, 'formal.json'));
assert.equal(sha(readFileSync(join(proof, 'formal.json'))), frozen.formalSha256);
const extraction = read(join(proof, 'extraction.json'));
const candidate = extraction.candidates.find(item => item.id === frozen.candidateId);
assert.equal(candidate.version, 1);
const archive = join(proof, 'release/afk-darwin-arm64.tar.gz');
assert.equal(sha(readFileSync(archive)), frozen.archiveDigest);
const root = realpathSync(mkdtempSync(join(tmpdir(), 'parcel-seven-')));
const node = realpathSync(process.execPath);
const observer = `import {checkManifest} from './scan-manifest.mjs';
const raw = process.argv[1];
try { console.log(JSON.stringify({raw, value:checkManifest(JSON.parse(raw))})); }
catch (error) { console.error(JSON.stringify({raw, name:error.name, message:error.message})); process.exitCode=1; }`;


try {
  execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', root], { env: { LC_ALL: 'C' } });
  const load = name => import(pathToFileURL(join(root, 'afk/node_modules/@afk/runtime/dist/application/learning', `${name}.js`)));
  const { readProposalCatalog } = await load('proposal-catalog');
  const { prepareAssetProposal } = await load('proposals');
  const { prepareProposalExperiment } = await load('proposal-semantics');
  const { canonicalLearningJson } = await load('requests');
  const [checker] = read(join(extraction.home, 'asset-gate-QOTe2o/bindings/checkers.json')).checkers;
  assert.equal(sha(canonicalLearningJson(checker)), receipt.checkerDigest);
  const catalog = readProposalCatalog({ scope: checker.scope, repositoryRoot: checker.repository.root,
    expectedCommit: receipt.expectedCommit, ...checker.inventory });
  const prepared = prepareAssetProposal(candidate.proposal, catalog.inventory);
  const asset = checker.asset.path;
  assert.equal(asset, 'script/scan-manifest.mjs');
  const sources = { original: execFileSync('/usr/bin/git', ['-C', checker.repository.root, 'show', `${receipt.expectedCommit}:${asset}`]),
    proposed: Buffer.from(prepared.artifact.content) };
  const digests = { original: sha(sources.original), proposed: sha(sources.proposed) };
  assert.equal(digests.original, '2ae3a06ca5fd0059dff855c705025862312493881f0463816be03064baaa2902');
  assert.equal(digests.original, prepared.artifact.originalDigest);
  assert.equal(digests.proposed, frozen.sourceDigest);
  for (const [edition, bytes] of Object.entries(sources)) {
    mkdirSync(join(root, edition));
    writeFileSync(join(root, edition, 'scan-manifest.mjs'), bytes, { mode: 0o400 });
  }
  const gate = spawnSync(node, [fileURLToPath(new URL('./tool-denial.mjs', import.meta.url)), proof], { encoding: 'utf8', timeout: 60000 });
  assert.equal(gate.status, 0, gate.stderr);
  const { installedRuntime, originalCLI } = JSON.parse(gate.stdout);
  const rows = [];
  const [normal, mixed, , invalid] = prepared.checks;
  for (const check of prepared.checks.filter(check => check.kind !== 'permission-denied')) {
    const controlled = ['cancellation', 'timeout'].includes(check.kind);
    const refusal = check.kind === 'refusal';
    const control = controlled ? { kind: check.kind, afterMs: check.kind === 'timeout' ? prepared.execution.timeoutMs : 500 } : undefined;
    const configuration = { protocol: 'proposal-semantic-v1', adapter: 'node-json-argv-v1', kind: check.kind, input: check.input,
      ...(controlled && { control, callInput: normal.input }), assertions: [
        { id: 'exit', source: 'exit-code', expected: controlled ? 137 : refusal ? 1 : 0 },
        controlled ? { id: 'control', source: 'control', path: ['kind'], expected: check.kind } :
          { id: 'output', source: refusal ? 'stderr' : 'stdout-json', expected: check.kind === 'normal' ? JSON.parse(check.expected) : check.expected }] };
    const preparation = prepareProposalExperiment('tool', asset, check, configuration, candidate.proposal.payload.inputSchema);
    const row = { check, preparation, observations: {} };
    rows.push(row);
    const recovery = check.kind === 'recovery';
    if (recovery) assert.deepEqual(preparation, { status: 'unsupported', reason: 'recovery_contract_unavailable' });
    else assert.equal(preparation.status, 'prepared');
    for (const edition of Object.keys(sources)) {
      const directory = join(root, edition);
      const observeExport = async raw => {
        const observation = await isolated(directory, ['--input-type=module', '-e', observer, '--', raw], control);
        assert.equal(observation.signal, null);
        if (control) assert.equal(observation.controlSent, false);
        const output = JSON.parse(observation.exit === 0 ? observation.stdout : observation.stderr);
        assert.equal(output.raw, raw);
        if (raw === invalid.input) {
          assert.equal(observation.exit, 1);
          assert.equal(output.name, 'TypeError');
          assert.notEqual(output.message, invalid.expected);
        } else {
          assert.equal(observation.exit, 0);
          const test = prepared.checks.find(item => item.input === raw);
          const expected = JSON.parse(test.expected);
          assert.deepEqual(output.value, edition === 'original' ? { ...expected, invalidLines: [] } : expected);
        }
        return observation;
      };
      if (recovery) {
        const repeats = [];
        for (const input of [invalid.input, mixed.input, mixed.input]) repeats.push(await observeExport(input));
        assert.equal(repeats[1].stdout, repeats[2].stdout);
        row.observations[edition] = { independentFreshProcessSequence: repeats };
      } else {
        const [runtime, path, raw] = preparation.experiment.argv;
        assert.deepEqual([runtime, path], ['node', `/workspace/${asset}`]);
        const entry = await isolated(directory, [join(directory, 'scan-manifest.mjs'), raw], control);
        assert.equal(entry.exit, 0, entry.stderr);
        assert.equal(entry.signal, null);
        assert.equal(entry.stdout + entry.stderr, '');
        if (control) assert.equal(entry.controlSent, false);
        row.observations[edition] = { raw, entry, directExport: await observeExport(raw) };
      }
    }
  }
  assert.equal(rows.length, 7);
  console.log(JSON.stringify({ version: frozen.version, candidateId: candidate.id, expectedCommit: receipt.expectedCommit,
    archiveDigest: frozen.archiveDigest, checkerDigest: receipt.checkerDigest, digests, platform: process.platform,
    arch: process.arch, node: process.version, nodeSha256: sha(readFileSync(node)), originalCLI, installedRuntime,
    assurance: 'diagnostic-only / darwin-seatbelt', rows }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
