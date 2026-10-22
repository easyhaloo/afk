import type { BacklogItem } from '../../../domain/backlog/index.js';
import type { ChangeProvider, ChangeRequest, CreateChangeInput } from './provider.js';
import type { TrackerProvider } from '../../../domain/tracker/types.js';
import { parseWorkItemId } from '../../../domain/work-item/identity.js';
import { resolveGitLabProjectKey } from '../../../shared/gitlab-project.js';
import { renderVerificationEvidence, type VerificationEvidence } from './verification-evidence.js';
import { logger } from '../../io/index.js';

export function renderChangeDescription(
  backlog: BacklogItem,
  tracker?: Pick<TrackerProvider, 'platform' | 'projectId' | 'providerHost'>,
  evidence?: VerificationEvidence,
): string {
  const issue = backlog.workItemId ?? (/^(github|gitlab):/.test(backlog.providerRef ?? '') ? backlog.providerRef : undefined);
  const issueNumber = Number(backlog.id);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new Error('backlog issue number is invalid');
  if (!issue || !tracker) return appendEvidence(`QA: PASS\nCloses #${issueNumber}`, evidence);
  const identity = parseWorkItemId(issue);
  if (identity.platform !== tracker.platform) throw new Error('issue and change request platform mismatch');
  if (identity.issueNumber !== issueNumber) throw new Error('issue number does not match backlog identity');
  const issueProject = identity.platform === 'gitlab'
    ? resolveGitLabProjectKey(identity.projectKey, tracker.providerHost).projectPath
    : identity.projectKey;
  if (backlog.project && (backlog.project.platform !== identity.platform
    || (backlog.project.projectKey !== identity.projectKey && backlog.project.projectKey !== issueProject))) {
    throw new Error('issue project metadata does not match canonical identity');
  }
  const sameProject = String(tracker.projectId).toLowerCase() === issueProject.toLowerCase()
    || (backlog.project?.providerProjectId !== undefined && String(tracker.projectId) === backlog.project.providerProjectId);
  const reference = sameProject ? `#${issueNumber}` : `${issueProject}#${issueNumber}`;
  return appendEvidence(`QA: PASS\nCloses ${reference}`, evidence);
}

function appendEvidence(body: string, evidence?: VerificationEvidence): string {
  const section = renderVerificationEvidence(evidence);
  return section ? `${body}\n\n${section}` : body;
}

export class TrackerChangeProvider implements ChangeProvider {
  constructor(private readonly tracker: TrackerProvider) {}

  async create(input: CreateChangeInput): Promise<ChangeRequest> {
    const artifacts = await this.uploadArtifacts(input);
    const id = await this.tracker.createMR({
      title: `Backlog ${input.backlog.id}: ${input.backlog.title}`,
      description: renderChangeDescription(input.backlog, this.tracker, { ...input.evidence, artifacts }),
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      draft: input.draft,
    });
    return this.get(String(id));
  }

  /**
   * Upload the artifacts a QA run registered. A failed upload must not stop
   * the publication: the text evidence still belongs in the description.
   */
  private async uploadArtifacts(input: CreateChangeInput) {
    if (!input.worktreePath) return [];
    try {
      return await this.tracker.uploadArtifacts(input.worktreePath, {
        backlogId: input.backlog.id,
        sourceBranch: input.sourceBranch,
        targetCommitish: input.commitSha ?? input.sourceBranch,
      });
    } catch (error) {
      logger.warn({ backlogId: input.backlog.id, worktreePath: input.worktreePath, error }, 'failed to upload QA verification artifacts');
      return [];
    }
  }

  async get(id: string): Promise<ChangeRequest> {
    const mr = await this.tracker.getMR(Number(id));
    return { id: String(mr.id), state: mr.state === 'opened' ? 'open' : mr.state, sourceBranch: mr.sourceBranch, targetBranch: mr.targetBranch, mergeable: mr.mergeable, url: mr.url };
  }

  async findForBacklog(backlog: BacklogItem): Promise<ChangeRequest | null> {
    const changes = await this.tracker.listMRs({ state: 'all' });
    const change = changes.find(candidate => candidate.sourceBranch === `${backlog.branchName}-qa`)
      ?? changes.find(candidate => candidate.sourceBranch === backlog.branchName);
    return change ? this.get(String(change.id)) : null;
  }

  async verifyIssueAssociation(change: ChangeRequest, canonicalWorkItemId: string): Promise<void> {
    const issue = parseWorkItemId(canonicalWorkItemId);
    if (issue.platform !== this.tracker.platform) throw new Error('issue and change request platform mismatch');
    const id = Number(change.id);
    if (!Number.isSafeInteger(id) || id <= 0 || !change.url) throw new Error('change request identity is incomplete');
    const fresh = await this.get(change.id);
    if (fresh.url !== change.url || fresh.id !== change.id || fresh.sourceBranch !== change.sourceBranch || fresh.targetBranch !== change.targetBranch) {
      throw new Error('change request identity mismatch on provider readback');
    }
    if (!(await this.tracker.isMRLinkedToIssue(id, issue.id))) {
      throw new Error(`change request ${change.id} is not linked to ${issue.id} on the provider`);
    }
  }

  async merge(id: string): Promise<void> { await this.tracker.mergeMR(Number(id), { deleteSourceBranch: true, squash: true }); }
  async close(id: string, reason?: string): Promise<void> { await this.tracker.closeMR(Number(id), { comment: reason }); }
}
