import type { AgentProvider } from '../../domain/agents/types';
import type { SandboxProvider } from '../../infrastructure/sandbox/types';
import type { WorkflowTemplate } from '../../domain/templates/types';
import type { LifecycleModule } from '../../application/workflows/lifecycle';
import type { BacklogProvider } from '../../domain/backlog/index';

export type PluginSystemAction = (input: unknown) => unknown | Promise<unknown>;

export interface PluginSetupContext {
  lifecycle(module: LifecycleModule): void;
  systemAction(name: string, action: PluginSystemAction): void;
  agentProvider(name: string, provider: AgentProvider): void;
  sandboxProvider(name: string, provider: SandboxProvider): void;
  template(template: WorkflowTemplate): void;
  /** Register a provider-native backlog implementation, including atomic claim. */
  backlogProvider(name: string, provider: BacklogProvider): void;
  dispose(disposer: () => void | Promise<void>): void;
}

export interface WorkflowPlugin {
  readonly id: string;
  readonly version: string;
  setup(context: PluginSetupContext): void | Promise<void>;
}

/**
 * Typed extension host for workflow runtime capabilities.
 * Plugins register capabilities during setup; they do not receive shell,
 * process, or resource-scope access and therefore cannot bypass execution
 * policy or terminal cleanup.
 */
export class PluginRuntime {
  private readonly plugins = new Map<string, WorkflowPlugin>();
  private readonly lifecycles: LifecycleModule[] = [];
  private readonly actions = new Map<string, PluginSystemAction>();
  private readonly agents = new Map<string, AgentProvider>();
  private readonly sandboxes = new Map<string, SandboxProvider>();
  private readonly templates = new Map<string, WorkflowTemplate>();
  private readonly backlogProviders = new Map<string, BacklogProvider>();
  private readonly disposers: Array<() => void | Promise<void>> = [];

  async load(plugin: WorkflowPlugin): Promise<void> {
    if (!plugin || !plugin.id || !plugin.version || typeof plugin.setup !== 'function') {
      throw new Error('invalid workflow plugin manifest');
    }
    if (this.plugins.has(plugin.id)) {
      throw new Error(`plugin '${plugin.id}' already loaded`);
    }

    const registered = {
      lifecycles: [] as LifecycleModule[],
      actions: [] as string[],
      agents: [] as string[],
      sandboxes: [] as string[],
    templates: [] as string[],
      backlogProviders: [] as string[],
      disposers: [] as Array<() => void | Promise<void>>,
    };
    const context: PluginSetupContext = {
      lifecycle: module => {
        if (!module?.name) throw new Error(`plugin '${plugin.id}' registered an invalid lifecycle module`);
        if (this.lifecycles.some(m => m.name === module.name) || registered.lifecycles.some(m => m.name === module.name)) {
          throw new Error(`duplicate lifecycle module '${module.name}'`);
        }
        this.lifecycles.push(module);
        registered.lifecycles.push(module);
      },
      systemAction: (name, action) => {
        this.assertName(name, 'system action');
        if (this.actions.has(name) || registered.actions.includes(name)) throw new Error(`duplicate system action '${name}'`);
        this.actions.set(name, action);
        registered.actions.push(name);
      },
      agentProvider: (name, provider) => {
        this.assertName(name, 'agent provider');
        if (this.agents.has(name) || registered.agents.includes(name)) throw new Error(`duplicate agent provider '${name}'`);
        this.agents.set(name, provider);
        registered.agents.push(name);
      },
      sandboxProvider: (name, provider) => {
        this.assertName(name, 'sandbox provider');
        if (this.sandboxes.has(name) || registered.sandboxes.includes(name)) throw new Error(`duplicate sandbox provider '${name}'`);
        this.sandboxes.set(name, provider);
        registered.sandboxes.push(name);
      },
      template: template => {
        if (!template?.name) throw new Error(`plugin '${plugin.id}' registered an invalid template`);
        if (this.templates.has(template.name) || registered.templates.includes(template.name)) throw new Error(`duplicate template '${template.name}'`);
        this.templates.set(template.name, template);
        registered.templates.push(template.name);
      },
      backlogProvider: (name, provider) => {
        this.assertName(name, 'backlog provider');
        if (!provider || typeof provider.claim !== 'function') {
          throw new Error(`plugin '${plugin.id}' registered an invalid backlog provider`);
        }
        if (this.backlogProviders.has(name) || registered.backlogProviders.includes(name)) {
          throw new Error(`duplicate backlog provider '${name}'`);
        }
        this.backlogProviders.set(name, provider);
        registered.backlogProviders.push(name);
      },
      dispose: disposer => {
        if (typeof disposer !== 'function') throw new Error(`plugin '${plugin.id}' registered an invalid disposer`);
        this.disposers.push(disposer);
        registered.disposers.push(disposer);
      },
    };

    try {
      await plugin.setup(context);
      this.plugins.set(plugin.id, plugin);
    } catch (error) {
      for (const module of registered.lifecycles) this.remove(this.lifecycles, module);
      for (const name of registered.actions) this.actions.delete(name);
      for (const name of registered.agents) this.agents.delete(name);
      for (const name of registered.sandboxes) this.sandboxes.delete(name);
      for (const name of registered.templates) this.templates.delete(name);
      for (const name of registered.backlogProviders) this.backlogProviders.delete(name);
      for (const disposer of registered.disposers) this.remove(this.disposers, disposer);
      throw error;
    }
  }

  listPlugins(): string[] { return [...this.plugins.keys()]; }
  listSystemActions(): string[] { return [...this.actions.keys()]; }
  getLifecycleModules(): LifecycleModule[] { return [...this.lifecycles]; }
  getAgentProvider(name: string): AgentProvider | undefined { return this.agents.get(name); }
  getSandboxProvider(name: string): SandboxProvider | undefined { return this.sandboxes.get(name); }
  getTemplate(name: string): WorkflowTemplate | undefined { return this.templates.get(name); }
  listBacklogProviders(): string[] { return [...this.backlogProviders.keys()]; }
  getBacklogProvider(name: string): BacklogProvider | undefined { return this.backlogProviders.get(name); }

  async dispatchSystemAction(name: string, input: unknown): Promise<unknown> {
    const action = this.actions.get(name);
    if (!action) throw new Error(`unknown system action '${name}'`);
    return action(input);
  }

  async close(): Promise<void> {
    for (const disposer of [...this.disposers].reverse()) await disposer();
    this.plugins.clear();
    this.lifecycles.length = 0;
    this.actions.clear();
    this.agents.clear();
    this.sandboxes.clear();
    this.templates.clear();
    this.backlogProviders.clear();
    this.disposers.length = 0;
  }

  private assertName(name: string, kind: string): void {
    if (!/^[a-z][a-z0-9.-]*$/.test(name)) throw new Error(`invalid ${kind} name '${name}'`);
  }

  private remove<T>(items: T[], item: T): void {
    const index = items.indexOf(item);
    if (index >= 0) items.splice(index, 1);
  }
}
