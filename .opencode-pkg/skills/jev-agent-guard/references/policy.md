# Jev Agent Guard policy

## Decision boundaries

- Deny known destructive shell commands and credential-file access locally.
- Let safe local reads and ordinary native permissions proceed without Jev.
- Moderate Jev action risk does not request a separate human confirmation;
  native host permissions remain responsible for any approvals.
- Ask Jev only for ambiguous Skill routing, network actions, repeated
  failures, or an observed Skill's completion checkpoint.
- At Stop, offer numbered Steps and Playbook items as bounded choices. Block
  completion only when Jev identifies a specific unfinished step and tool
  evidence was observed; include that step in the host's continuation message.
  If no step can be established, give a non-blocking, actionable review hint
  without claiming that the work is incomplete. Recheck after new tool evidence.
- Give each Jev request a 2.5-second timeout and no retries; do not cap
  requests per session.
- Preserve host permissions if Jev fails.
  A Jev decision alone cannot authorize a tool.
- Restore only bounded Skill step titles and tool-result counts after a
  compaction event; do not replay full transcripts.

## Data sent to Jev

The allowlisted event state may include host, session identifier, tool name,
action risk category, selected Skill name, up to 12 extracted step titles
and constraints, and up to 40 tool-name/success evidence pairs. It does not
include raw tool input/output or source files. Skill text receives bounded
best-effort redaction; do not place credentials in Skill descriptions or
step titles. Audit records contain only rule and decision metadata.

## Output reduction

Only successful, warning-free dependency installation logs above the
threshold are compacted. Tests, failures, warnings, explicit full-output
requests, and commands outside the allowlist are preserved. The replacement
states how many lines were omitted and how to recover them by rerunning the
command. Codex has no output replacement in this integration.
