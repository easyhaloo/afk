/**
 * The cross-project backlog graph, read from the credential-scoped catalogs.
 *
 * The tracker adapter reads one project at a time, so it cannot see a child
 * that lives in another repository. This source asks every project the
 * credentials can reach for the issues that carry the parent label.
 *
 * The query is label-filtered, so a project answers with the children and
 * nothing else; the project list itself is read once and reused.
 */

import type { BacklogGraphSource } from '../../domain/backlog/graph.js';
import type { BacklogItem } from '../../domain/backlog/index.js';
import { BACKLOG_RELATION_PREFIX } from '../../domain/backlog/metadata-codec.js';
import { projectBacklogItem } from '../../domain/backlog/projection.js';
import type { ProviderProjectRef } from '../../domain/work-item/types.js';
import type { TrackerProvider } from '../../domain/tracker/types.js';
import {
  createGitHubTracker,
  createGitLabTracker,
  createGlobalWorkItemCatalogs,
  type GlobalTrackerPlatform,
} from './tracker-provider-factory.js';

export interface CrossProjectBacklogGraphOptions {
  /** Which provider platforms the graph spans. */
  platform?: GlobalTrackerPlatform;
  /** Creates the tracker used to read one project. */
  trackerFor?: (project: ProviderProjectRef) => Promise<TrackerProvider>;
}

async function defaultTrackerFor(project: ProviderProjectRef): Promise<TrackerProvider> {
  if (project.platform === 'github') return createGitHubTracker(project.projectKey);
  const host = project.providerHost;
  const prefix = host ? `${host}/` : '';
  const projectId = project.providerProjectId
    ?? (prefix && project.projectKey.startsWith(prefix) ? project.projectKey.slice(prefix.length) : project.projectKey);
  return createGitLabTracker(projectId, undefined, host);
}

/**
 * A backlog graph that spans every project the credentials can reach.
 *
 * The children of an item are the issues that carry `parent::<identity>`.
 * Because the identity is canonical, the same query finds a child in the
 * current repository and a child in another one.
 */
export function createCrossProjectBacklogGraphSource(options: CrossProjectBacklogGraphOptions = {}): BacklogGraphSource {
  const platform = options.platform ?? 'all';
  const trackerFor = options.trackerFor ?? defaultTrackerFor;
  let projectsPromise: Promise<ProviderProjectRef[]> | undefined;

  const projects = (): Promise<ProviderProjectRef[]> => {
    projectsPromise ??= (async () => {
      const discovered: ProviderProjectRef[] = [];
      for (const catalog of createGlobalWorkItemCatalogs(platform)) {
        try {
          const result = await catalog.listProjects();
          discovered.push(...(Array.isArray(result) ? result : result.items));
        } catch {
          // A platform without credentials must not hide the other one.
        }
      }
      return discovered;
    })();
    return projectsPromise;
  };

  return {
    async childrenOf(id: string): Promise<BacklogItem[]> {
      const label = `${BACKLOG_RELATION_PREFIX.parent}${id}`;
      const children: BacklogItem[] = [];
      for (const project of await projects()) {
        const tracker = await trackerFor(project);
        const issues = await tracker.listIssues({ state: 'all', labels: [label] });
        for (const issue of issues) {
          children.push(projectBacklogItem({
            issueNumber: issue.id,
            title: issue.title,
            description: issue.description,
            labels: issue.labels,
            state: issue.state,
            webUrl: issue.url,
          }, { platform: project.platform, projectKey: project.projectKey }));
        }
      }
      return children;
    },
  };
}
