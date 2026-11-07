---
name: jev-agent-guard
description: >-
  Globally install Jev checkpoints for Claude Code, Codex, and OpenCode.
  Recommend relevant Skills, monitor observable execution evidence, and
  reduce safe tool-output noise without replacing host permissions.
license: MIT
compatibility: Requires Node.js 20+, the local @typesafe-ai/sdk dependency, and TYPESAFE_API_KEY for live evaluation.
metadata:
  author: easyhaloo
  version: "2.0"
---

# Jev Agent Guard

## Global installation

The installer may be launched from any working directory. Replace the path
below with the absolute path to this Skill on your machine:

```bash
export TYPESAFE_API_KEY="your-key"
node /path/to/skills/jev-agent-guard/scripts/install.mjs --global
```

Use `--dry-run` before installing, `--host=claude-code,codex,opencode` to
select hosts, `doctor` to inspect configuration, and `uninstall` to remove
only this Skill's host entries. The runtime is copied to a stable user data
directory and uses user-level hooks/plugins, not a project checkout. The
uninstaller retains runtime files so other host integrations remain intact.

## Runtime behavior

Host adapters normalize observable events and use local checks before Jev:

- prompt → suggest a relevant Skill from bounded metadata; use Jev for
  ambiguous candidate selection
- before tool → deny known destructive/credential access locally; ask Jev
  about bounded network actions without adding a confirmation prompt
- after tool → record limited evidence; ask Jev after repeated failures
- stop → recognize numbered Steps/Playbook requirements; block with a specific
  unfinished step only when supported by observed evidence, then recheck after
  new tool evidence without recursive blocking
- after compaction → restore a concise active-Skill and evidence checkpoint
- successful dependency-install output → conservatively reduce model-facing
  noise on hosts with tested output replacement

The guard does not inspect private reasoning. It observes host events and
never requests human confirmation on behalf of Jev or substitutes for native
permissions. OpenCode has no
native Stop hook equivalent in this integration, so its Skill completion
check remains advisory rather than blocking.

## Safety and privacy

Provider requests use an allowlisted, bounded state; complete tool input,
output, files, and environment are not forwarded. Selected Skill step titles
and constraints may be included after best-effort secret redaction. Only
decisions and rule names are written to audit logs. Without Jev, native host
permissions remain in force; deterministic local denials still apply.

Rules remain in `rules/semantic.json` and contain no host-specific fields.
