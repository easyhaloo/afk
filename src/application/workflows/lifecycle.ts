import type { ProjectContext } from '../project-context';

export type LifecyclePhase = 'init' | 'before-agent' | 'after-agent' | 'cleanup';
export type ModuleParamValue = string | number | boolean | null;
export type ModuleParams = Record<string, Record<string, ModuleParamValue>>;

export interface InitContext {
  iid: number;
  projectName: string | undefined;
  baseBranch: string;
  params: ModuleParams;
  originalCwd: string;
  repoRoot?: string;
  projectContext?: ProjectContext;
}

export interface LifecycleContext {
  iid: number;
  worktreePath: string;
  baseBranch: string;
  sessionName: string;
  params: ModuleParams;
  repoRoot?: string;
  projectName?: string;
  originalCwd?: string;
}

export interface LifecycleModule {
  name: string;
  order?: number;
  onInit?(ctx: InitContext): Promise<void>;
  onBeforeAgent?(ctx: LifecycleContext): Promise<void>;
  onAfterAgent?(ctx: LifecycleContext): Promise<void>;
  onCleanup?(ctx: LifecycleContext): Promise<void>;
}

export class LifecycleDispatcher {
  private readonly modules: LifecycleModule[];
  private readonly extensions = new Map<LifecyclePhase, Array<{ order: number; index: number; handler: (ctx: InitContext | LifecycleContext) => Promise<void> }>>();

  constructor(modules: LifecycleModule[] = []) {
    this.modules = modules.map((module, index) => ({ ...module, order: module.order ?? index }));
    this.modules.sort((a, b) => a.order! - b.order!);
  }

  register(phase: LifecyclePhase, handler: (ctx: InitContext | LifecycleContext) => Promise<void>, order = 0): void {
    const list = this.extensions.get(phase) ?? [];
    list.push({ order, index: list.length, handler });
    list.sort((a, b) => a.order - b.order || a.index - b.index);
    this.extensions.set(phase, list);
  }

  async run(phase: LifecyclePhase, ctx: InitContext | LifecycleContext): Promise<void> {
    const entries = phase === 'cleanup' ? [...this.modules].reverse() : this.modules;
    for (const module of entries) {
      const hook = phase === 'init' ? module.onInit
        : phase === 'before-agent' ? module.onBeforeAgent
          : phase === 'after-agent' ? module.onAfterAgent : module.onCleanup;
      if (!hook) continue;
      try {
        await hook(ctx as never);
      } catch (error) {
        if (phase === 'init') throw error;
      }
    }
    const extensions = this.extensions.get(phase) ?? [];
    const ordered = phase === 'cleanup' ? [...extensions].reverse() : extensions;
    for (const extension of ordered) {
      try {
        await extension.handler(ctx);
      } catch (error) {
        if (phase === 'init') throw error;
      }
    }
  }
}

export type ModuleFactory = () => LifecycleModule;
