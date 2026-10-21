import type { ContainerEngine } from './sandbox.js';

/**
 * The resources a run registers.
 *
 * A run registers the environments it used - a tmux session, a container,
 * an isolate service - so the desktop can show what is still running and
 * what can be attached to. The kinds, the origins and the states were
 * written down in the registry, again in the desktop's wire contract, and
 * again in the database's check constraints.
 *
 * The lists live in the core package, because the desktop reads them from
 * a renderer that cannot load the registry, and the registry's table has to
 * be created from the same answer.
 */

/** The kinds of environment a run can register. */
export const AFK_RESOURCE_KINDS = ['tmux', 'container', 'isolate-service'] as const;

export type AfkResourceKind = (typeof AFK_RESOURCE_KINDS)[number];

/** Where a registered resource came from. */
export const AFK_RESOURCE_ORIGINS = ['local-sandbox', 'container-sandbox', 'isolate'] as const;

export type AfkResourceOrigin = (typeof AFK_RESOURCE_ORIGINS)[number];

/** The states a registered resource can be in. */
export const AFK_RESOURCE_STATUSES = ['active', 'closed', 'missing', 'failed'] as const;

export type AfkResourceStatus = (typeof AFK_RESOURCE_STATUSES)[number];

/** The container engines a registered container can run on. */
export const AFK_RESOURCE_ENGINES: readonly ContainerEngine[] = ['docker', 'podman'];

export type AfkResourceEngine = ContainerEngine;

/** What the registry knows about a resource beyond its columns. */
export interface AfkResourceMetadata {
  [key: string]: unknown;
}

/**
 * A registered resource.
 *
 * The shape of the row, not a copy of the table's columns: the registry
 * owns the table and this is what it hands out, so a reader that needs
 * another column gets it from the registry rather than writing the query
 * out again.
 */
export interface AfkResourceRecord {
  id: string;
  resourceKey: string;
  workspacePath: string;
  runId?: string;
  worktreePath: string;
  kind: AfkResourceKind;
  origin: AfkResourceOrigin;
  engine?: AfkResourceEngine;
  name: string;
  externalId?: string;
  status: AfkResourceStatus;
  detail?: string;
  metadata: AfkResourceMetadata;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}
