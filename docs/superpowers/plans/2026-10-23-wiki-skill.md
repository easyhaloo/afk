# Wiki Skill Implementation Plan

**Goal:** Ship a self-contained Obsidian wiki skill with a bundled local CLI and executable end-to-end checks.

**Architecture:** The agent extracts knowledge from its current context and prepares a version-checked JSON change plan. A Python standard-library CLI searches, reads, lints, previews, and applies that plan. Vault rules and templates are runtime inputs; an existing vault-local linter remains authoritative when present.

**Tech Stack:** Python 3.10+, ripgrep, unittest, subprocess; no service or model dependency.

## Tasks

- [x] Add `skills/wiki/scripts/test_wiki.py`: invoke the actual CLI against temporary vaults; cover preview/apply/replay, evidence requirements, metadata and links, search/read, concurrent edits, path/symlink boundaries, redaction, and vault-local lint integration. Run before implementation and confirm a missing CLI failure.
- [x] Add `skills/wiki/scripts/wiki.py`: implement `search`, `read`, `lint`, and `ingest`; validate inputs, preserve file permissions, compare hashes before replacing files, check candidate snapshots, and recover partial writes without overwriting concurrent changes. Inject a filesystem failure in one focused unit check to verify rollback.
- [x] Add `skills/wiki/SKILL.md` and operation references: define context distillation, evidence and uncertainty handling, CLI contracts, rule/template loading, and actionable limitations. Clarify the authoring guide's runtime-input exception and document the skill in both existing language guides.
- [x] Run the CLI tests, skill validation, and documentation link checks. Exercise read-only commands against the existing coding-wiki and verify its file contents remain unchanged. Record results here without modifying the real vault.

## Acceptance

The complete workflow runs in a disposable vault without Obsidian or a model API. Preview changes no vault files. Apply writes the page, backlink, and index together; replay is unchanged. Invalid plans, new lint errors, stale hashes, sensitive paths, and escaping paths fail without overwriting data. Recovery survives an injected mid-batch filesystem failure. Existing AFK commands and unrelated working-tree changes remain untouched.

## Verification results — 2026-10-23

- `python3 -B -m unittest discover -s skills/wiki/scripts -p 'test_wiki.py' -v`: 22 tests passed, comprising 20 CLI subprocess scenarios and 2 filesystem failure-injection checks. Includes bundle relocation, post-write lint rollback, and preservation of intervening human edits.
- Skill creator's `quick_validate.py skills/wiki`: valid.
- `node scripts/check-doc-links.mjs`: 243 Markdown files checked, no broken links.
- `git diff --check`: passed.
- Existing coding-wiki: real search, read, vault-backend lint, and ingest preview passed. SHA-256 snapshots confirmed all 78 Markdown/Base files unchanged. Its lint reported 0 errors and 26 preexisting warnings.
- Claude Code integration: the source skill is linked at the user's `~/.claude/skills/wiki`. A real authenticated Claude session invoked the Skill tool and made 12 CLI calls against a disposable fixture vault. Context distillation, evidence-backed merging, inbox routing, exclusion of transient details, preview/apply, unchanged replay, search/read, and final lint passed (0 errors, 0 warnings). Private execution evidence is in `.afk/wiki-e2e/2026-10-23-claude/`; the reusable runner is `skills/wiki/scripts/e2e_claude.py`.
- Live integration evaluates the supplied fixture rather than proving general factual accuracy. The company vault was not modified by the Claude Code run.

## Vault discovery follow-up — 2026-10-23

- Added shared discovery for all commands: explicit option, environment,
  nearest project `.wiki.json`, then user configuration. `locate` and JSON
  response metadata identify the selected vault and source. Invalid selected
  configuration fails without fallback.
- Configured this user's default from the existing wiki protocol, without
  changing company wiki content. Pathless locate/search/lint passed; all 78
  Markdown/Base hashes remained unchanged.
- Deterministic suite: 28 tests passed, including config precedence, relative
  project paths, invalid configuration, and ingest using project discovery.
- Live Claude Code run: 14 CLI calls, no `--vault` or `WIKI_VAULT`, complete
  extraction/preview/apply/replay/retrieval checks passed; final lint 0 errors
  and 0 warnings. Evidence: `.afk/wiki-e2e/2026-10-23-autodiscovery/`.
- Skill validation and documentation links passed (245 Markdown files).
