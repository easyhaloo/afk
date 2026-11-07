# @easyhaloo/afk-opencode

[AFK](https://github.com/easyhaloo/afk) workflow skills for
[OpenCode 2.x](https://opencode.ai) — install the plugin **and** the full skill
suite with one command.

```sh
opencode plugin add @easyhaloo/afk-opencode
```

## What it does

AFK is a thin OpenCode V2 plugin (`{ id, setup }`) bundled with its skill suite.
Because OpenCode discovers **skills** only from on-disk skills directories (it
does not read `SKILL.md` from inside an installed npm package), the bundled
skills are copied into your global OpenCode skills directory:

```
${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/<skill-name>/
```

This happens on **two** paths (same shared installer):

- **On plugin load** — OpenCode calls the plugin's `setup(ctx)` every time it
  loads `afk`. `opencode plugin add` does **not** run npm lifecycle scripts, so
  `setup()` is what actually installs the skills on the OpenCode path.
- **On manual install** — a direct `npm i @easyhaloo/afk-opencode` runs the
  package's `postinstall` hook, which installs the same skills.

Either way the copy is:

- **Idempotent** — safe to reinstall; AFK-owned skill dirs are refreshed.
- **Cheap on repeat** — a skill dir is only rewritten when its content actually
  differs, and repeat sessions log at most one concise line.
- **Non-destructive** — never deletes unrelated skills already in the directory.
- **Resilient** — a non-fatal copy error is logged as a warning and the plugin
  still loads regardless.

## The skills

24 skills are auto-installed, covering requirements, implementation, testing,
research, QA, and hand-off — e.g. `afk-do`, `afk-implement`, `afk-testing`,
`afk-research`, `afk-qa`, `afk-diagnose`, `reasoning-guard`, and more. See the
[full skill list](https://github.com/easyhaloo/afk/tree/main/skills).

### `jev-agent-guard` is opt-in

`jev-agent-guard` is **not** auto-installed: it owns its own host integration and
installs hooks/plugins into `claude-code`/`codex`/`opencode`. To enable it, run
its installer from the unpacked package:

```
node_modules/@easyhaloo/afk-opencode/skills/jev-agent-guard
```

## Verify

```sh
opencode plugin list   # should list "afk"
```

Then start an OpenCode session and try, for example, `@afk-do`.

## Links

- Repository: https://github.com/easyhaloo/afk
- License: MIT