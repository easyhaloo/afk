import type { PluginRuntime } from '../../shared/plugins/runtime';

export type SystemActionName = 'publish-change' | 'queue-qa';
export type SystemActionHandler = (context: unknown) => unknown | Promise<unknown>;

export interface SystemActionExecutorOptions {
  publishChange: SystemActionHandler;
  queueQA: SystemActionHandler;
  plugins?: PluginRuntime;
}

/** Fixed system action boundary. No template action executes an arbitrary command. */
export class SystemActionExecutor {
  constructor(private readonly options: SystemActionExecutorOptions) {}

  async execute(action: string, context: unknown): Promise<unknown> {
    switch (action) {
      case 'publish-change': return this.options.publishChange(context);
      case 'queue-qa': return this.options.queueQA(context);
      default:
        if (this.options.plugins) return this.options.plugins.dispatchSystemAction(action, context);
        throw new Error(`unknown system action '${action}'`);
    }
  }
}
