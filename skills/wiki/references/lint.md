# Wiki Lint

## Select the checker

The bundled CLI uses the target vault's `.tools/wiki-lint.py` when present.
The checker is invoked through Python with the requested vault, age threshold,
and JSON mode; it must emit a `findings` list and exit 1 for errors or 0
otherwise. Failures, timeouts, malformed JSON, or inconsistent exit status are
reported as execution failures. There is no silent fallback from a broken
vault checker.

Read this executable before trusting it. Existing coding-wiki's checker owns
its directory-specific fields, naming, backlink, template, and cross-page
snapshot rules. Keep those rules in the vault; do not copy the checker here.

Without a vault checker, portable checks cover required frontmatter fields
and tags from the directory template, ISO update dates, stale-page warnings,
wikilink targets and heading/block anchors, ambiguous targets, empty sections,
index membership when `00-总览.md` exists, and possible credential assignments.
Template fields support scalar values, inline scalar lists, and indented
scalar lists. This is not a general YAML validator. Portable checks do not
infer arbitrary prose rules, enforce every business rule, or check standard
Markdown links and external URLs.

## Interpret results

Each finding contains `check`, `level`, `file`, `line`, `rule`, and `message`.
Reports include the backend and error/warning counts. A path restricts the
report after full-vault checking, preserving cross-page context.

- Errors fail standalone lint; warnings return success.
- Old dates require evidence review; changing a date alone is not a repair.
- A missing backlink and a contradictory fact require different fixes.
- Secret detection and output redaction are heuristics, not a security audit.
- A clean mechanical check does not establish factual accuracy.

Lint alone is read-only. When repair is authorized, read affected pages and
their rules, apply the minimum evidence-backed changes through ingest, and
rerun the checks. Report unresolved factual questions using the vault's inbox
rules; do not invent their answers to clear lint.
