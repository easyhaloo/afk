import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CandidateStore } from './candidate-store.js';
import { candidateProposalSchema, type CandidateProposal } from './contracts.js';
import { request, evidence, output } from './ledger-data.fixture.spec.js';
import type { KnowledgePolicy } from './knowledge.js';

export const wikiScript = fileURLToPath(new URL('../../../../../skills/wiki/scripts/wiki.py', import.meta.url));
export const hash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
export const page = (title: string, body: string) => `---\ntags: [knowledge]\nlast_updated: 2026-11-10\n---\n# ${title}\n\n${body}\n`;

export function knowledgeFixture(proposal?: CandidateProposal) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'knowledge-publication-'));
  const vault = join(root, 'vault');
  const recoveryDirectory = join(root, 'recovery');
  mkdirSync(vault);
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(vault, path)), { recursive: true });
    writeFileSync(join(vault, path), content);
  };
  write('AGENTS.md', '# Rules\nUse the template; preserve proposals and evidence gaps.\n');
  write('00-总览.md', page('总览', '[[知识/入口]]'));
  write('知识/入口.md', page('入口', '[[00-总览]]'));
  write('知识/_模板.md', page('{{title}}', '{{knowledge}}'));
  write('99-收件箱/_模板.md', page('{{title}}', '{{knowledge}}'));
  const policy: KnowledgePolicy = {
    scope: request.scope, vault,
    rules: { 'AGENTS.md': hash(readFileSync(join(vault, 'AGENTS.md'))), '.tools/wiki-lint.py': null },
    targets: [{ ref: 'wiki:approval', paths: ['知识/Approval.md'], kinds: ['fact', 'process'], inbox: false,
      templatePath: '知识/_模板.md', indexPaths: ['00-总览.md'], backlinkPaths: ['知识/入口.md'] },
    { ref: 'wiki:inbox', paths: ['99-收件箱/Proposal.md'], kinds: ['fact', 'process'], inbox: true,
      templatePath: '99-收件箱/_模板.md', indexPaths: ['00-总览.md'], backlinkPaths: ['知识/入口.md'] }],
  };
  const store = new CandidateStore({ file: join(root, 'ledger.sqlite') });
  const authorizationFile = join(root, 'knowledge-grant.json');
  const persistGrant = (revoked = false, allowWithdrawal = true) => writeFileSync(authorizationFile,
    JSON.stringify({ version: 1, revoked, allowWithdrawal, policy }), { mode: 0o600 });
  persistGrant();
  const candidateProposal = proposal ?? candidateProposalSchema.parse({ ...output.candidates[0], targetRef: 'wiki:approval' });
  const receipt = store.completeRequest(store.submitRequest({ request, evidence: [evidence] }).key,
    { version: 1, candidates: [candidateProposal], warnings: [] });
  const original = store.getCandidate(receipt.candidateIds[0]!)!;
  const candidate = store.recordValidation(original.id, original.version, {
    candidateDigest: original.digest, evidenceDigest: original.evidenceDigest,
    validatorVersion: 'knowledge-v1', passed: true, results: ['evidence and scope verified'],
  });
  return { root, vault, recoveryDirectory, policy, store, candidate, wikiScript, write, authorizationFile, persistGrant,
    input: { store, candidateId: candidate.id, expectedVersion: candidate.version, policy, wikiScript, recoveryDirectory, authorizationFile },
    cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
