import type { ProjectContext } from '../project/context.js';
import type { PreparedRepository } from './multi-repository-preparer.js';
import type { ProviderAbortSignal } from '../../plugin-sdk/capabilities.js';
import { withCancellation } from '../plugins/cancellation.js';

export type LifecyclePhase = 'init' | 'before-agent' | 'after-agent' | 'before-publish' | 'cleanup';
export type ModuleParamValue = string | number | boolean | null;
export type ModuleParams = Record<string, Record<string, ModuleParamValue>>;

export interface InitContext {
  readonly signal?: ProviderAbortSignal;
  iid: number;
  projectName: string | undefined;
  baseBranch: string;
  params: ModuleParams;
  originalCwd: string;
  repoRoot?: string;
  projectContext?: ProjectContext;
  repositories?: readonly PreparedRepository[];
}

export interface LifecycleContext {
  readonly signal?: ProviderAbortSignal;
  iid: number;
  worktreePath: string;
  baseBranch: string;
  sessionName: string;
  params: ModuleParams;
  repoRoot?: string;
  projectName?: string;
  originalCwd?: string;
  repositories?: readonly PreparedRepository[];
}

export interface LifecycleModule {
  name: string;
  order?: number;
  failureMode?: 'required' | 'best-effort';
  onInit?(ctx: InitContext): Promise<void>;
  onBeforeAgent?(ctx: LifecycleContext): Promise<void>;
  onAfterAgent?(ctx: LifecycleContext): Promise<void>;
  onBeforePublish?(ctx: LifecycleContext): Promise<void>;
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
    const cleanup = phase === 'cleanup' && ctx.signal ? new AbortController() : undefined;
    const timer = cleanup ? setTimeout(() => cleanup.abort(new Error('Lifecycle cleanup timed out')), 15_000) : undefined;
    const context = cleanup ? { ...ctx, signal: cleanup.signal } : ctx;
    try { await this.dispatch(phase, context); }
    finally { if (timer) clearTimeout(timer); }
  }

  private async dispatch(phase: LifecyclePhase, ctx: InitContext | LifecycleContext): Promise<void> {
    const options = ctx.signal ? { signal: ctx.signal } : undefined;
    await withCancellation(() => undefined, options);
    const entries = phase === 'cleanup' ? [...this.modules].reverse() : this.modules;
    for (const module of entries) {
      const hook = phase === 'init' ? module.onInit
        : phase === 'before-agent' ? module.onBeforeAgent
          : phase === 'after-agent' ? module.onAfterAgent : phase === 'before-publish' ? module.onBeforePublish : module.onCleanup;
      if (!hook) continue;
      try {
        await withCancellation(() => hook(ctx as never), options);
      } catch (error) {
        if (phase === 'init' || (phase !== 'cleanup' && module.failureMode === 'required')) throw error;
      }
      if (phase !== 'cleanup') await withCancellation(() => undefined, options);
    }
    const extensions = this.extensions.get(phase) ?? [];
    const ordered = phase === 'cleanup' ? [...extensions].reverse() : extensions;
    for (const extension of ordered) {
      try {
        await withCancellation(() => extension.handler(ctx), options);
      } catch (error) {
        if (phase === 'init') throw error;
      }
      if (phase !== 'cleanup') await withCancellation(() => undefined, options);
    }
  }
}

export type ModuleFactory = () => LifecycleModule;
