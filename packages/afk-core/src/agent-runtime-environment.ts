/**
 * The environment an agent run happens in.
 *
 * A run is carried by a transport, it authenticates in some way, and it
 * is reached on an endpoint of some kind. A person also *chooses* how a
 * run should be carried and authenticated, and a choice may be "auto",
 * which means AFK decides.
 *
 * The recorded values and the chosen values are not one list. A run
 * reports the transport it was actually carried by - the plain process a
 * provider runs in, or one of the ways a codex run can be hosted - and
 * reports "unknown" when it could not tell how it authenticated. A choice
 * offers "auto" instead. Writing both lists in each place meant a
 * transport the runtime could carry was refused by the command that
 * offers it, and by the desktop that shows the choice.
 *
 * The lists live in the core package because the desktop client reads
 * them from a renderer that cannot load the execution runtime, and the
 * core package is the one layer every one of them can reach.
 */

/** The transports an agent run can be carried by. */
export const AGENT_TRANSPORTS = ['process', 'exec', 'app-server'] as const;

export type AgentTransport = (typeof AGENT_TRANSPORTS)[number];

/**
 * How an agent run authenticates.
 *
 * 'unknown' says the run could not tell. It is not the same as a run
 * that authenticated with a key.
 */
export const AGENT_AUTHS = ['chatgpt', 'api', 'unknown'] as const;

export type AgentAuth = (typeof AGENT_AUTHS)[number];

/** The kinds of endpoint an agent can be reached on. */
export const AGENT_ENDPOINT_KINDS = ['stdio', 'unix', 'ws', 'wss'] as const;

export type AgentEndpointKind = (typeof AGENT_ENDPOINT_KINDS)[number];

/** The transports a person can choose for a run. 'auto' means AFK decides. */
export const AGENT_TRANSPORT_CHOICES = ['auto', 'exec', 'app-server'] as const;

export type AgentTransportChoice = (typeof AGENT_TRANSPORT_CHOICES)[number];

/** The ways a person can choose to authenticate. 'auto' means AFK decides. */
export const AGENT_AUTH_CHOICES = ['auto', 'chatgpt', 'api'] as const;

export type AgentAuthChoice = (typeof AGENT_AUTH_CHOICES)[number];
