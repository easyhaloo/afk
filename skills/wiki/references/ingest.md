# Context Ingest

## Distill before writing

Use the current conversation, user confirmations, inspected code, and tool or
test results. Extract independent claims, not a transcript or an operation log.
Do not call a model service or collect external sources to recreate context.

Keep reusable behavior, business rules, operational prerequisites, system
boundaries, verified troubleshooting knowledge, and decisions with meaningful
tradeoffs. Skip repetition, transient progress, unused suggestions, and facts
outside the vault's content domains.

For each candidate, identify its evidence, scope, knowledge owner, and state:

| State | Action |
| --- | --- |
| Confirmed, already documented | Skip; do not refresh its date |
| Confirmed, adds to an existing topic | Rewrite only affected sections |
| Confirmed, supersedes an older fact | Verify the conflict and update current truth |
| Confirmed, new topic | Use its domain template and create one page |
| Valuable decision | Use the vault's decision-record template |
| Uncertain, contradictory, or missing required facts | Use the vault's inbox rules; never invent required values |

One successful operation does not establish a general rule. Discussion of a
design does not prove adoption. Search absence does not establish nonexistence.
Preserve verified facts from unrelated sections. Treat competing evidence as
an unresolved question until its authority and applicable version are known.

## Prepare the changes

1. Search for the topic and terminology variants; read related pages in full.
2. Read the domain template, index, and pages requiring reciprocal links.
3. Follow the target vault's field names and structure. Put provenance in an
   allowed source section; avoid new mandatory properties. Keep the body as a
   current snapshot when the vault prohibits changelogs.
4. Use the SHA-256 from a full-page read as the expected version. A section
   read returns the whole file's hash but only section content: read the full
   page before preparing its complete replacement. Do not rewrite a page from
   redacted content; route detected credentials to the authorized workflow.
5. Include the page, required backlinks, and index changes in the same plan.
   Change `last_updated` only for pages with substantive knowledge changes.

## Plan contract

The `ingest` operation consumes a UTF-8 JSON file or standard input, selected
through its required `--plan` argument. Plans are limited to 8 MiB. Root keys:

| Key | Type | Meaning |
| --- | --- | --- |
| `version` | integer | Exactly 1 |
| `summary` | nonempty string | Knowledge being added or corrected |
| `evidence` | nonempty list of nonempty strings | Traceable evidence from this context |
| `changes` | nonempty list | Complete Markdown file replacements |

Every change has exactly three keys:

| Key | Type | Meaning |
| --- | --- | --- |
| `path` | string | Vault-relative Markdown path |
| `expected_sha256` | string or null | Current lowercase SHA-256; null requires a new file |
| `content` | nonempty string | Complete desired UTF-8 page content |

Store transient plans in a private temporary directory outside the vault.
Plans can contain private business information. Remove them after completion.
No credentials belong in plans. File deletion and template/rule changes are
outside this command's scope.

## Preview and apply

The command defaults to preview. It checks the complete plan, compares file
versions, creates a private candidate snapshot, and runs lint against that
snapshot. Errors newly introduced anywhere in the graph block the plan;
preexisting errors are reported separately through the candidate findings.

With existing write authorization, use `--apply` to execute the checked plan.
Each file is checked again immediately before replacement, its permissions are
preserved, and the resulting vault is linted. Identical content returns
`unchanged` without rewriting files, even when replaying the original plan.

On exit 3, re-read the affected pages and merge with the new content. On a
write failure, inspect the reported recovery receipt. It records original
file copies, applied paths, restored paths, and paths that could not safely
be restored. Never overwrite an intervening human edit to complete recovery.
Remove the recovery directory only after recovery has been verified.

Replacements are atomic per file, not a multi-file filesystem transaction.
Optimistic hashes do not lock Obsidian; a narrow race remains between the last
check and replacement. Abrupt process termination may leave a partial batch;
the private recovery directory contains the original files and intended
post-write hashes. Avoid editing the same pages in parallel.
