/**
 * The container engines a run can use, and the kinds a run runs in.
 *
 * The engines are a sandbox question, not a registry one: a resource
 * row records the engine a container ran on, and the registry took the
 * names from a second list of its own.
 *
 * The kinds are the same kind of question. A provider that runs a
 * container is a container, whatever it is called. The rule lives in the
 * core package because two runners asked the same question - where a run's
 * transcript can be read from - and each wrote the answer down. A provider
 * added to one and not to the other would have its run read from the wrong
 * place.
 */

/** The container engines a run can use. */
export const CONTAINER_ENGINES = ['docker', 'podman'] as const;

export type ContainerEngine = (typeof CONTAINER_ENGINES)[number];

/** The kinds a sandbox runs in. */
export const SANDBOX_KINDS = ['local', 'container'] as const;

export type SandboxKind = (typeof SANDBOX_KINDS)[number];
