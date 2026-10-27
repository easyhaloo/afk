# Wiki Session Ingest Implementation Report

Date: 2026-10-27

## Scope

Implemented a session reader for the `skills/wiki` workflow. The reader does
not write wiki files; it normalizes a selected session into JSON so the Skill
can distill evidence and create the existing version-1 plan for
`wiki.py ingest --plan`.

## Supported sources

- Claude Code local session JSONL in `~/.claude/projects/`, matched by exact
  session filename.
- Codex rollout JSONL in `~/.codex/sessions/`, matched by session ID in the
  filename.
- Explicit exports in JSON, JSONL, Markdown, and text, including ChatGPT-style
  `mapping` JSON exports and common message-array exports.

Remote APIs are intentionally not called. A ChatGPT conversation ID by itself
does not grant access to history; ChatGPT history must be explicitly exported.
Other native local formats need a dedicated adapter or an export.

## Safety and behavior

- Fails on missing or ambiguous session matches rather than guessing.
- Reads local files only; rejects symlink transcript files and files over 64 MiB.
- Redacts common secret-bearing lines and private-key blocks.
- Defaults to a 250,000-character cap and fails rather than silently truncating.
- Counts malformed JSONL records and marks the transcript incomplete.
- Emits source, message count, character count, completeness, warnings, and
  normalized message indexes for evidence provenance.
- Reuses the existing wiki preview/apply/lint pipeline; no direct wiki writes.

## Tests added

Eleven deterministic tests cover Claude records, Codex records, ChatGPT mapping
exports, generic JSONL, text exports, secret redaction, malformed JSONL,
oversize rejection, symlink rejection, ambiguous discovery, and CLI JSON output.
A targeted GitHub Actions workflow compiles the scripts and runs all
`test_*.py` suites in `skills/wiki/scripts`.

## Validation status

The first targeted run compiled both scripts successfully and ran 39 tests;
the existing wiki CLI suite had seven failures because the runner did not have
ripgrep installed. The workflow now installs ripgrep before running the suite.
The rerun must pass before claiming the full Python suite passed. Direct local
execution was unavailable because direct GitHub network access failed.
