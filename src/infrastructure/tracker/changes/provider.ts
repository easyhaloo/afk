import type { BacklogItem } from '../../../domain/backlog/index.js';

export interface ChangeRequest {
  id: string;
  state: 'open' | 'merged' | 'closed';
  sourceBranch: string;
  targetBranch: string;
  mergeable?: boolean;
  url?: string;
}

export interface ChangeProvider {
  create(input: { backlog: BacklogItem; sourceBranch: string; targetBranch: string; draft?: boolean }): Promise<ChangeRequest>;
  get(id: string): Promise<ChangeRequest>;
  findForBacklog(backlog: BacklogItem): Promise<ChangeRequest | null>;
  verifyIssueAssociation(change: ChangeRequest, canonicalWorkItemId: string): Promise<void>;
  merge(id: string): Promise<void>;
  close(id: string, reason?: string): Promise<void>;
}
