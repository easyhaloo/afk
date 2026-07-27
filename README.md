# AFK Claude Code Plugin

AFK CLI skill suite for Claude Code — requirements interview, implementation, research, pipeline, and hand-off workflows.

## Skills

| Skill | Description |
|-------|-------------|
| [afk-grill-me](skills/afk-grill-me/) | From-scratch requirements interview — ambiguous → falsifiable shared understanding |
| [afk-grill-me-context](skills/afk-grill-me-context/) | Gap-fill interview — verify/correct existing context |
| [afk-implement](skills/afk-implement/) | Implementation workflow — spec → code → verify |
| [afk-research](skills/afk-research/) | Deep research harness for technical investigations |
| [afk-qa](skills/afk-qa/) | QA workflow for skill evaluation and testing |
| [afk-pipeline](skills/afk-pipeline/) | Pipeline orchestration and scheduling |
| [afk-to-prd](skills/afk-to-prd/) | Publish results to PRD |
| [afk-to-issues](skills/afk-to-issues/) | Create GitLab issues from findings |
| [afk-debug](skills/afk-debug/) | Debugging workflow |
| [afk-do](skills/afk-do/) | Task execution and orchestration |
| [afk-hand-off](skills/afk-hand-off/) | Context handoff between sessions |
| [afk-prototype](skills/afk-prototype/) | Prototype development workflow |
| [afk-scheduler](skills/afk-scheduler/) | Scheduled task orchestration |

## Installation

### Via npx (recommended)

```bash
# Install all afk skills globally
npx skills add easyhaloo/afk --agent claude-code -g -y

# Install a specific skill
npx skills add easyhaloo/afk --skill afk-grill-me --agent claude-code -g -y
```

### Via Claude Code marketplace

```
/marketplace add afk https://github.com/easyhaloo/afk
```
