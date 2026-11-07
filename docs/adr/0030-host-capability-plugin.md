# ADR-0030: Shared Host and Capability Plugins

## Status

Accepted — November 6, 2026.

Current implementation and adoption status are maintained in
[Capability plugins](../architecture/plugins.md) /
[能力插件架构](../architecture/plugins.zh.md).

## Context

Host access originally lived in Electron-specific SSH and JumpServer code.
CLI use would duplicate process execution, parsing and failure handling.
Agent, sandbox, tracker, verification, notification, trigger, context,
credential, artifact, repository and policy integrations need the same shared
construction and typed provider boundary. Registering a provider must not
silently give it authority over work identity or managed execution policy.

## Decision

Use the shared `PluginRuntime` and API v1 contracts exported by
`@afk/runtime/plugin-sdk`. A standard plugin declares a `PluginManifest`,
registers typed providers during `activate(context)`, and supplies disposers
for acquired resources. Capability IDs follow the SDK profile, including
`agent.provider`, `sandbox.provider`, `tracker.issue`, `host.connection` and
the other `*.provider` families.

`HostConnectionPort` is a Core port consumed by shared Application use cases.
JumpServer, SSH, AWS SSM and Kubernetes Exec are Runtime adapters. CLI and
Desktop own their command, IPC, PTY and rendering surfaces. The common
composition contract is `createDefaultPluginRuntime`. CLI execute, QA, loop,
schedule and run paths and the Desktop execution Worker use this assembly.
Managed implementation and QA receive the same Runtime and provider registries;
each process disposes the instance it owns. Desktop Agent menus and configuration
saves use registered provider names, including external plugins, and reject
unknown selections.
CLI managed commands reuse an injected `composition.pluginRuntime`; they
construct and dispose a fallback only when one was not supplied.

Work identity, reducer/state machine, execution eligibility, repository lease
semantics, audit authority, retry budgets and the human merge gate remain
mandatory Core/managed-execution behavior. Observability exporters and additional
policy checks do not replace those rules. Linear and Jira supply an independent
`IssueTrackerPort`; they are not adapters for GitHub/GitLab's repository-backed
backlog identity or change-request workflow.
Configured GitHub/GitLab register tracker and backlog providers. Shared assembly
adopts a tracker matching the execution platform, project and applicable host,
rejects ambiguous matches, and uses the existing source-host factory when no
configured tracker matches.

An explicitly started `plugin serve-container` service hosts the remote-container
protocol through the same sandbox/agent registries. Its repository, existing
workspace boundary, sandbox selection, agent allowlist and environment token
are explicit inputs. Loopback binding is the default; remote binding/clients
require opt-in. This service hosts execution operations, not arbitrary plugin
code in a new security sandbox. The trigger event listener is a separate service.

Install trusted local directories or npm package specifications through
`PluginManager`. A package provides `package.json`, a `plugin.json` containing
the standard manifest plus optional relative `entry` (default `dist/index.js`),
and its built entry. Stage installation and dependencies under
`~/.afk/plugins/`, with npm lifecycle scripts disabled. Record the manifest,
resolved entry and entry SHA-256 in `install.json`; publish by directory rename
and preserve the previous directory on ordinary upgrade failure.

`~/.afk/plugins.yml` declares enablement and JSON-compatible settings. Validate
the envelope with Zod and plugin configuration against its JSON Schema with
AJV. Installed modules may export a factory receiving configuration, home and
workspace paths. Entries marked `builtin: true` are constructed by configured
builtin factories, not imported by the installed-module loader. Those factories
own the concrete provider schemas, secret references and transport construction.

Activate in capability dependency order. Runtime registrations commit as one
batch; activation failure rolls the batch back and runs disposers in reverse.
Full shutdown disposes plugins in reverse activation order. Missing dependencies,
conflicts, invalid settings and failed imports produce plugin diagnostics.
Core command handling can continue when an optional plugin fails to load.
An explicit override suppresses the same-ID default even when loading fails;
it cannot silently select a different implementation. Configuration parse
errors omit YAML source excerpts. Trigger shutdown stops new intake and drains
tracked handlers and timer callbacks before completing disposal.

Configured triggers select a registered action at the plugin entry and can
declare static JSON `input` on each descriptor independently of `payload`
event filters. Dispatch prefers descriptor input, then received event payload,
then descriptor payload. The builtin `work-item.execute` action runs a canonical
work item through `executeWorkItem` using the same Runtime and registry; stopped
or failed statuses throw, while merge remains human controlled.

Selected policy integrations run before and after the Agent and in
`onBeforePublish` (`before-publish`), with required failure semantics. The engine
calls publication hooks before branch pushes and before each prepared
repository's publication. The after-agent module also checks policies before
artifact uploads and notifications. QA runs required initialization and
before-agent hooks, references gathered context through the worktree file, and
runs after-agent integrations on a passing result. It separately evaluates
publication policy before pushing its verification branch and before publishing
or updating the change request. Managed callers propagate the shared Runtime's
registries, actions and lifecycle modules into these execution paths.
Secret-scan evaluation prefers the trusted execution worktree over its fallback
root. Unsafe paths, read failures and incomplete scans block required policy;
oversized files produce a denied `secret-scan-incomplete` decision.

## Consequences

- CLI and Desktop can share host adapters, provider configuration and runtime
  assembly without importing Electron into the Core or shared use cases.
- The same capability can have several plugins and named Runtime providers.
  Resolved profiles map capabilities to manifest arrays; consumers select a
  provider explicitly. Duplicate runtime provider names still fail.
- Dependent plugins may use setup-context provider getters during activation,
  including private credential resolution. CLI invocation excludes credential
  output.
- A provider needs an explicit consumer. Registration alone does not attach
  notifications, triggers, context or policy checks to the managed lifecycle.
- Credentials, external binaries and protocol-compatible remote services remain
  deployment requirements. HTTP adapters do not deploy those services.
- Plugins are trusted local code with host-process privileges. `--ignore-scripts`
  limits installation behavior; staging separates dependency layouts; neither
  establishes execution isolation. An entry digest does not attest the complete
  dependency tree or verify a publisher.
- There is no marketplace, signature verification or per-plugin process sandbox.
  Activation rollback covers registrations and declared cleanup, not arbitrary
  import/factory side effects or crash recovery across filesystem/config writes.
- Management commands change subsequent runtime construction. They do not
  hot-replace providers in a running Desktop Worker.
