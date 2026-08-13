import type { BacklogItem } from '../../../domain/backlog/index';
import type { ChangeProvider, ChangeRequest } from './provider';
import type { TrackerProvider } from '../../../domain/tracker/types';

export class TrackerChangeProvider implements ChangeProvider {
  constructor(private readonly tracker: TrackerProvider) {}

  async create(input: { backlog: BacklogItem; sourceBranch: string; targetBranch: string; draft?: boolean }): Promise<ChangeRequest> {
    const id = await this.tracker.createMR({
      title: `Backlog ${input.backlog.id}: ${input.backlog.title}`,
      description: input.backlog.description,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      draft: input.draft,
    });
    return this.get(String(id));
  }

  async get(id: string): Promise<ChangeRequest> {
    const mr = await this.tracker.getMR(Number(id));
    return { id: String(mr.id), state: mr.state === 'opened' ? 'open' : mr.state, sourceBranch: mr.sourceBranch, targetBranch: mr.targetBranch, url: mr.url };
  }

  async findForBacklog(backlog: BacklogItem): Promise<ChangeRequest | null> {
    const changes = await this.tracker.listMRs({ state: 'opened' });
    const change = changes.find(candidate => candidate.sourceBranch === backlog.branchName);
    return change ? this.get(String(change.id)) : null;
  }

  async merge(id: string): Promise<void> { await this.tracker.mergeMR(Number(id), { deleteSourceBranch: true, squash: true }); }
  async close(id: string, reason?: string): Promise<void> { await this.tracker.closeMR(Number(id), { comment: reason }); }
}
