# User-level host integration

Install from any working directory using the absolute path to the source
`scripts/install.mjs`. Run `--dry-run` first. By default, install targets all
three hosts; select a subset with `--host=claude-code,codex,opencode`.

The POSIX runtime lives at `${XDG_DATA_HOME:-$HOME/.local/share}/jev-agent-guard/current/`.
Windows uses `%LOCALAPPDATA%/jev-agent-guard/current/`. The source repository
is not required after installation. The installer copies a pinned SDK
dependency into a staged runtime before switching `current`; it does not
install packages in unrelated projects.

Host configuration is user-level:

| Host | Location | Entry |
| --- | --- | --- |
| Claude Code | `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json` | Hook groups for `SessionStart` after compaction, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop` |
| Codex | `${CODEX_HOME:-$HOME/.codex}/hooks.json` | Hook groups for `SessionStart` after compaction, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` |
| OpenCode | `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/jev-agent-guard.js` | ESM plugin with prompt, tool, and context handlers |

Existing hook groups remain intact. `uninstall` removes only commands whose
installed adapter path belongs to Jev Agent Guard. The original config gets
a `.jev-agent-guard.bak` backup on first write. Invalid existing JSON aborts
the install before configuration is changed.
Backups are created with owner-only permissions (`0600`) because host settings
may contain credentials.
The local semantic audit directory and log also use owner-only permissions;
audit records contain rule IDs and decisions, not raw provider state.

`doctor` emits machine-readable JSON with runtime and configuration state.
It reports `loaded` and `triggered` as `unverified` until a real host
integration probe has run; a file on disk is not proof a host executed a hook.
Codex may require hook trust before executing user-level hooks. A noninteractive
session that does not trust the hook can run without Jev even when `hooks.json`
is present. Review and trust the installed command through the host's normal
flow; `--dangerously-bypass-hook-trust` is only suitable for a controlled probe
after checking the hook source, not as a default installation option.
Remote/cloud agents require installation in their own execution environment.
OpenCode V1 plugin loading is supported for versions 1.18.29 and later;
unknown and V2 plugin APIs are rejected rather than silently misconfigured.

Jev does not return an `ask` decision to any host; moderate risk leaves native
permissions unchanged. Host-native approvals can still apply independently.
OpenCode's tool-before hook can block a deterministic denial, while its
completion feedback cannot block a completed agent turn in this integration.
None of the adapters return an explicit `allow` that grants host permission.
