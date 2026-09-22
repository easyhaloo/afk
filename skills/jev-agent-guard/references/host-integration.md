# Jev Agent Guard Policy

This document captures the default policy used by the shared agent guard skill.

## Default decisions

- Local read of project files: allow
- Local write within the active workspace: allow with narrow scope
- Declared test or lint command: allow
- Arbitrary shell command: confirm or deny depending on command shape
- Network request: confirm
- Secret or credential access: deny
- Destructive git command: deny
- External code download and execution: deny
- CI, deployment, or permission config mutation: confirm or deny

## Fail-closed rules

The guard defaults to deny when there is uncertainty for:

- credential access
- destructive git actions
- external execution
- policy change
- network call with unknown destination

## Context compression rules

Keep the following first:

- user requirements
- acceptance criteria
- current diff
- most recent error or validation failure
- latest successful checkpoint

Drop or compact:

- repeated logs
- stale search results
- superseded tool output
- broad unrelated context

## Trajectory rules

Trigger redirect when:

- same command repeats after failure
- same file is edited repeatedly without new evidence
- validation is skipped after a major local change
- scope expands without new requirements

## Jev usage

Jev is optional and should be invoked only when:

- the decision is ambiguous and semantic
- the task spans multiple files and deeper reasoning
- logs are long and require root-cause triage
- tool outputs are too noisy to safely classify locally

Never use Jev as a substitute for host or user approval.

## Host integration

The shared guard can be integrated through:

- Claude Code hooks
- Codex hooks or wrappers
- OpenCode plugins

The host-specific adapter scripts in `scripts/adapters/` normalize host events into the same guard protocol.

## Required output contract

Every evaluation should return a JSON object containing at least:

- `decision`
- `action`
- `dimension`
- `reason`
- `host`
- `tool`
- `command`

The payload should be compact enough for a pre-tool check or a post-tool status update.
