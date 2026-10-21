/**
 * The resources a run registers.
 *
 * A run registers the environments it used - a tmux session, a container,
 * an isolate service - so the desktop can show what is still running and
 * what can be attached to. The kinds, the origins and the states were
 * written down in the registry, again in the desktop's wire contract,
 * and again in the database's check constraints.
 *
 * The lists live in the domain layer, because the desktop reads them
 * from a renderer that cannot load the registry, and the registry's
 * table has to be created from the same answer.
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
export const AFK_RESOURCE_ENGINES = ['docker', 'podman'] as const;

export type AfkResourceEngine = (typeof AFK_RESOURCE_ENGINES)[number];

/**
 * The values of a column, quoted the way SQL wants them.
 *
 * The table's check constraints are the database's answer to "which
 * values may this column hold", and they are written from the same
 * lists the registry reads.
 */
export function sqlValueList(values: readonly string[]): string {
  return values.map(value => `'${value}'`).join(', ');
}
