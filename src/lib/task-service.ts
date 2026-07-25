import { Task } from '../types/dashboard';

export class TaskService {
  async listTasks(): Promise<Task[]> {
    return [];
  }

  async createTaskFromIssue(issue: any, options: any): Promise<Task> {
    return {} as Task;
  }
}
