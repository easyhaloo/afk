import { createManagementProviders, type TrackerPlatform } from './infrastructure/provider/tracker-provider-factory.js';
import { addBacklogTag, confirmBacklogMerge, createBacklog, interruptBacklog, listBacklogs, removeBacklogTag, showBacklog } from './domain/backlog/commands.js';
import type { BacklogCreateInput, BacklogListOptions } from './domain/backlog/index.js';
import type { ManagementProviderBundle } from './infrastructure/provider/providers.js';
import { loadWorkflowConfig } from './infrastructure/config/manager.js';

type ProviderFactory = (project?: string, cwd?: string, platform?: TrackerPlatform) => Promise<Pick<ManagementProviderBundle, 'backlog' | 'changes'>>;

export function createBacklogRuntime(factory: ProviderFactory = createManagementProviders) {
  const provider = async (workspace: string, platform?: TrackerPlatform) => (await factory(undefined, workspace, platform)).backlog;
  return {
    async list(workspace: string, options: BacklogListOptions & { platform?: TrackerPlatform } = {}) {
      return listBacklogs(await provider(workspace, options.platform), options);
    },
    async show(workspace: string, id: string) {
      return showBacklog(await provider(workspace), id);
    },
    async create(workspace: string, input: BacklogCreateInput & { platform?: TrackerPlatform }) {
      return createBacklog(await provider(workspace, input.platform), input);
    },
    async addTag(workspace: string, id: string, tag: string) {
      const backlog = await provider(workspace);
      await addBacklogTag(backlog, id, tag);
      return showBacklog(backlog, id);
    },
    async removeTag(workspace: string, id: string, tag: string) {
      const backlog = await provider(workspace);
      await removeBacklogTag(backlog, id, tag);
      return showBacklog(backlog, id);
    },
    async interrupt(workspace: string, id: string, reason: string) {
      return interruptBacklog(await provider(workspace), id, reason);
    },
    async confirmMerge(workspace: string, id: string) {
      const providers = await factory(undefined, workspace);
      return confirmBacklogMerge(providers.backlog, providers.changes, id, loadWorkflowConfig(workspace).targetBranch);
    },
  };
}

export type BacklogRuntime = ReturnType<typeof createBacklogRuntime>;
