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
 * The issue number a canonical identity ends in.
 */
function issueNumberOf(id: string): number | undefined {
  const match = /#([1-9]\d*)$/.exec(id);
  return match ? Number(match[1]) : undefined;
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
      // A relation label is either the canonical identity of the parent or,
      // when the parent lives in the same project, its issue number. The short
      // form only means something inside the project it is read in, so it is
      // queried per project and the decoded identity decides which candidate
      // really points here.
      const labels = [`${BACKLOG_RELATION_PREFIX.parent}${id}`];
      const issueNumber = issueNumberOf(id);
      if (issueNumber !== undefined) labels.push(`${BACKLOG_RELATION_PREFIX.parent}${issueNumber}`);

      const children: BacklogItem[] = [];
      const seen = new Set<string>();
      for (const project of await projects()) {
        const tracker = await trackerFor(project);
        // The providers filter labels with AND semantics, so each form of the
        // label needs its own query.
        const found = (await Promise.all(labels.map(label => tracker.listIssues({ state: 'all', labels: [label] }))))
          .flat();
        for (const issue of found) {
          let child: BacklogItem;
          try {
            child = projectBacklogItem({
              issueNumber: issue.id,
              title: issue.title,
              description: issue.description,
              labels: issue.labels,
              state: issue.state,
              webUrl: issue.url,
            }, { platform: project.platform, projectKey: project.projectKey });
          } catch {
            // The projection is fail-closed: an issue whose metadata cannot be
            // trusted is not a child anybody may act on. A scan over several
            // repositories must not let one unreadable issue hide the others.
            continue;
          }
          // The label query matched text. The decoded parent identity is the
          // authority on whether this issue points here: a short-form label in
          // another project names that project's issue, not this one.
          if (child.parentId !== id) continue;
          const key = `${project.platform}:${project.projectKey}#${issue.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          children.push(child);
        }
      }
      return children;
    },
  };
}
