import { TmuxSession } from '../types/dashboard';

export class SessionService {
  async listSessions(): Promise<TmuxSession[]> {
    return [];
  }

  async killSession(name: string): Promise<void> {
    // noop
  }
}
