import { tmux as createTmux, Tmux } from 'node-tmux';

export interface TmuxSession {
  name: string;
  window: string;
  dir: string;
  status?: string;
  created?: string;
}

export class SessionService {
  private tmux: Tmux | null = null;
  private initPromise: Promise<void>;

  constructor() {
    this.initPromise = this.init();
  }

  private async init(): Promise<void> {
    this.tmux = await createTmux();
  }

  private async getTmux(): Promise<Tmux> {
    await this.initPromise;
    if (!this.tmux) {
      throw new Error('tmux not available');
    }
    return this.tmux;
  }

  async listSessions(): Promise<TmuxSession[]> {
    try {
      const tmux = await this.getTmux();
      const sessionNames = await tmux.listSessions();
      return sessionNames.map(name => ({
        name,
        window: 'main',
        dir: '',
        status: 'active',
      }));
    } catch {
      return [];
    }
  }

  async killSession(name: string): Promise<void> {
    const tmux = await this.getTmux();
    await tmux.killSession(name);
  }
}
