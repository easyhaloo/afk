import type { BacklogItem } from '../../../domain/backlog/index.js';
import { scopeChangeCandidates, selectChangeAssociation, type ChangeAssociationOptions } from '../../../domain/backlog/change-association.js';
import type { ChangeProvider, ChangeRequest, CreateChangeInput } from './provider.js';
import type { TrackerProvider, TrackedMR } from '../../../domain/tracker/types.js';
import { parseWorkItemId } from '../../../domain/work-item/identity.js';
import { resolveGitLabProjectKey } from '../../../shared/gitlab-project.js';
import { closesIssue } from './closing-reference.js';
import { renderVerificationEvidence, type VerificationEvidence } from './verification-evidence.js';
import { logger } from '../../io/index.js';

/** How long AFK waits for the platform to link a merge request to its issue. */
const ASSOCIATION_TIMEOUT_MS = 30_000;

/** How often AFK asks the platform whether the association is there. */
const ASSOCIATION_POLL_MS = 2_000;

/** The body a change request carries for a backlog item and its evidence. */
export function renderChangeDescription(
  backlog: BacklogItem,
  tracker?: Pick<TrackerProvider, 'platform' | 'projectId' | 'providerHost'>,
  evidence?: VerificationEvidence,
): string {
  const issue = backlog.workItemId ?? (/^(github|gitlab):/.test(backlog.providerRef ?? '') ? backlog.providerRef : undefined);
  const issueNumber = resolveIssueNumber(backlog, issue);
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

/**
 * The provider issue number of a backlog item.
 *
 * The backlog id is the canonical global identity — `platform:projectKey#issue`
 * — so it is not a number. The issue number travels with the item itself, and
 * the identity is the last fallback.
 */
function resolveIssueNumber(backlog: BacklogItem, issue?: string): number {
  const candidates: number[] = [];
  if (backlog.issueNumber !== undefined) candidates.push(backlog.issueNumber);
  candidates.push(Number(backlog.id));
  if (issue) {
    try {
      candidates.push(parseWorkItemId(issue).issueNumber);
    } catch {
      // A provider reference that is not a canonical identity carries no number.
    }
  }
  return candidates.find(candidate => Number.isSafeInteger(candidate) && candidate > 0) ?? Number.NaN;
}

export interface TrackerChangeProviderOptions {
  /** How long to wait for the platform to link the change request to its issue. */
  associationTimeoutMs?: number;
  /** How often to ask the platform whether the association is there. */
  associationPollMs?: number;
}

export class TrackerChangeProvider implements ChangeProvider {
  private readonly associationTimeoutMs: number;
  private readonly associationPollMs: number;

  constructor(private readonly tracker: TrackerProvider, options: TrackerChangeProviderOptions = {}) {
    this.associationTimeoutMs = options.associationTimeoutMs ?? ASSOCIATION_TIMEOUT_MS;
    this.associationPollMs = options.associationPollMs ?? ASSOCIATION_POLL_MS;
  }

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
    return { id: String(mr.id), state: mr.state === 'opened' ? 'open' : mr.state, sourceBranch: mr.sourceBranch, targetBranch: mr.targetBranch, mergeable: mr.mergeable, mergeState: mr.mergeState, url: mr.url, ...(mr.description ? { description: mr.description } : {}) };
  }

  /**
   * The change request of a backlog item.
   *
   * A branch can carry more than one change — a probe that was aimed at
   * another branch, a retry, a change that was opened by mistake — so the
   * change is picked by the rule of the association, not by the order a
   * listing happens to answer in.
   */
  async findForBacklog(backlog: BacklogItem, options: ChangeAssociationOptions = {}): Promise<ChangeRequest | null> {
    const { scope } = await this.candidatesForBacklog(backlog);
    return selectChangeAssociation(scope, options);
  }

  /**
   * Every change request that shares a branch of a backlog item.
   *
   * The changes of the branch that carries the item come first; the changes
   * on the other branch of the item follow, because a person reading a failed
   * reconciliation has to see them too.
   */
  async listForBacklog(backlog: BacklogItem): Promise<ChangeRequest[]> {
    const { scope, others } = await this.candidatesForBacklog(backlog);
    return [...scope, ...others];
  }

  /**
   * The changes that carry the work of a backlog item.
   *
   * The verification branch is where the change of an item is published; the
   * branch of the item itself is the fallback for a change that was published
   * without one. The changes on the branch that was not taken are kept
   * apart: they are not the item's change, but they are the alternatives a
   * person has to know about.
   */
  private async candidatesForBacklog(backlog: BacklogItem): Promise<{ scope: ChangeRequest[]; others: ChangeRequest[] }> {
    const changes = await this.tracker.listMRs({ state: 'all' });
    const { scope, others } = scopeChangeCandidates(changes, backlog.branchName);
    return {
      scope: await Promise.all(scope.map(candidate => this.readCandidate(candidate))),
      others: await Promise.all(others.map(candidate => this.readCandidate(candidate))),
    };
  }

  /**
   * The state a candidate really has.
   *
   * A listing answers in groups of states and can under-report a change that
   * has landed, so the readback of the provider is the truth. A readback
   * that fails leaves the listed state standing rather than losing the
   * candidate altogether — and says so, because a state nobody read back
   * must not pass for a state that was read.
   */
  private async readCandidate(candidate: TrackedMR): Promise<ChangeRequest> {
    try {
      return await this.get(String(candidate.id));
    } catch (error) {
      logger.warn({ changeRequestId: candidate.id, error }, 'failed to read the state of a change request; the listed state stands');
      return {
        id: String(candidate.id),
        state: candidate.state === 'opened' ? 'open' : candidate.state,
        sourceBranch: candidate.sourceBranch,
        targetBranch: candidate.targetBranch,
      };
    }
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
    // The platform resolves the issue references in a description into a link
    // between the merge request and the issue it closes — but only for a
    // merge request that targets the default branch of its project. A change
    // that has to land on a release branch never gets that link, even though
    // its description names the issue it closes. The native link is the
    // stronger evidence and is used first; the description is what remains.
    const deadline = Date.now() + this.associationTimeoutMs;
    for (;;) {
      if (await this.tracker.isMRLinkedToIssue(id, issue.id)) return;
      if (closesIssue(fresh.description, issue.issueNumber, this.issueProjectPath(issue))) return;
      if (Date.now() >= deadline) {
        throw new Error(`change request ${change.id} is not linked to ${issue.id} on the provider`);
      }
      await new Promise(resolve => setTimeout(resolve, this.associationPollMs));
    }
  }

  /** The repository path the issue lives in, the way a reference spells it. */
  private issueProjectPath(issue: { platform: string; projectKey: string }): string {
    return issue.platform === 'gitlab'
      ? resolveGitLabProjectKey(issue.projectKey, this.tracker.providerHost).projectPath
      : issue.projectKey;
  }

  async refresh(
    id: string,
    backlog: BacklogItem,
    evidence: Omit<VerificationEvidence, 'artifacts'>,
    worktreePath?: string,
  ): Promise<ChangeRequest> {
    if (!this.tracker.updateMR) throw new Error('the provider cannot refresh a change request');
    const change = await this.get(id);
    const artifacts = await this.uploadArtifacts({
      backlog, sourceBranch: change.sourceBranch, targetBranch: change.targetBranch, worktreePath,
    });
    await this.tracker.updateMR(Number(id), {
      description: renderChangeDescription(backlog, this.tracker, { ...evidence, artifacts }),
    });
    return this.get(id);
  }

  async merge(id: string): Promise<void> { await this.tracker.mergeMR(Number(id), { deleteSourceBranch: true, squash: true }); }
  async close(id: string, reason?: string): Promise<void> { await this.tracker.closeMR(Number(id), { comment: reason }); }
}
