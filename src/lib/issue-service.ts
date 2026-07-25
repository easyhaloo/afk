import { Issue } from '../types/dashboard';

export class IssueService {
  async listIssues(_projectId?: string | number): Promise<Issue[]> {
    return [];
  }
}
