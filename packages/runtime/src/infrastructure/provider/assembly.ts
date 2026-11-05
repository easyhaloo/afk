import { parseWorkItemId, gitLabProjectHost, type WorkItemPlatform } from '../../domain/work-item/identity.js';
import { resolveGitLabProjectKey } from '../../shared/gitlab-project.js';
import { logger } from '../io/index.js';
import { createTracker } from './tracker-provider-factory.js';
import { createCrossProjectBacklogGraphSource } from './backlog-graph.js';
import { asManagementProviders, createProviderBundle, type ProviderBundleOptions } from './providers.js';

export async function assembleProviders(input: {
  workItemId?: string;
  projectId?: string;
  projectKey?: string;
  platform?: WorkItemPlatform;
  providerHost?: string;
  cwd?: string;
  options?: ProviderBundleOptions;
}) {
  const identity = input.workItemId ? parseWorkItemId(input.workItemId) : undefined;
  if (identity && input.platform && identity.platform !== input.platform) throw new Error('provider platform conflicts with work item identity');
  if (identity && input.projectKey && identity.projectKey !== input.projectKey) throw new Error('provider project conflicts with work item identity');
  const platform = identity?.platform ?? input.platform;
  const projectKey = identity?.projectKey ?? input.projectKey;
  const providerHost = input.providerHost ?? (!input.projectId && platform === 'gitlab' && projectKey ? gitLabProjectHost(projectKey) : undefined);
  if (!input.projectId && platform === 'gitlab' && projectKey && input.providerHost && gitLabProjectHost(projectKey)
    && resolveGitLabProjectKey(projectKey, input.providerHost).host !== gitLabProjectHost(projectKey)) throw new Error('provider host conflicts with work item identity');
  const location = platform === 'gitlab' && projectKey ? resolveGitLabProjectKey(projectKey, providerHost) : undefined;
  const tracker = await createTracker(input.projectId ?? location?.projectPath ?? projectKey, input.cwd, platform, providerHost);
  const providers = createProviderBundle(tracker, input.cwd ?? process.cwd(), {
    graph: createCrossProjectBacklogGraphSource({ platform }),
    onGraphError: error => logger.warn({ error }, 'cross-project backlog graph is unavailable'),
    ...input.options,
    ...(projectKey ? { projectKey } : {}),
  });
  return { providers, management: asManagementProviders(providers) };
}
