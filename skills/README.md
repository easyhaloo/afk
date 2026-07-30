# Skills

Claude Code skill suite for AFK workflow automation. Each skill is self-contained and activated by its trigger command.

## Active Skills

| Skill | Trigger | Description |
|-------|---------|-------------|
| [afk-do](./afk-do/) | `/afk-do` | Direct task execution — TDD, spike, research, or hotfix modes |
| [afk-research](./afk-research/) | `/afk-research` | Technical investigation with structured findings report |
| [afk-grill-me](./afk-grill-me/) | `/afk-grill-me` | Requirements interview — ambiguous → falsifiable shared understanding |
| [afk-grill-me-context](./afk-grill-me-context/) | `/afk-grill-me-context` | Gap-fill interview — verify/correct existing context |
| [afk-hand-off](./afk-hand-off/) | `/afk-hand-off` | Session handoff — zero context loss between sessions |
| [reasoning-guard](./reasoning-guard/) | `/reasoning-guard` | Self-watch — detect degraded reasoning paths mid-session |

## Pipeline Skills

| Skill | Trigger | Description |
|-------|---------|-------------|
| [afk-implement](./afk-implement/) | `/afk-implement` | Spec → code → verify implementation workflow |
| [afk-pipeline](./afk-pipeline/) | `/afk-pipeline` | Pipeline orchestration and scheduling |
| [afk-scheduler](./afk-scheduler/) | `/afk-scheduler` | Task scheduling and queue management |
| [afk-prototype](./afk-prototype/) | `/afk-prototype` | Prototype development workflow |

## QA & Output Skills

| Skill | Trigger | Description |
|-------|---------|-------------|
| [afk-qa](./afk-qa/) | `/afk-qa` | Skill evaluation and testing |
| [afk-to-prd](./afk-to-prd/) | `/afk-to-prd` | Publish results to PRD document |
| [afk-to-issues](./afk-to-issues/) | `/afk-to-issues` | Create tracker issues from findings |
| [md-to-pdf](./md-to-pdf/) | `/md-to-pdf` | Convert Markdown to PDF |

## Testing Skills

| Skill | Trigger | Description |
|-------|---------|-------------|
| [api-workflow](./api-workflow/) | `/api-workflow` | API testing with request chaining and browser hybrid |

## Debug Skills

| Skill | Trigger | Description |
|-------|---------|-------------|
| [afk-debug](./afk-debug/) | `/afk-debug` | Debugging workflow for complex failures |
| [reasoning-watchdog](./reasoning-watchdog/) | `/reasoning-watchdog` | Hook-based reasoning quality monitoring |

---

Each skill directory contains:
- `SKILL.md` — skill manifest and activation instructions
- `references/` — methodology docs, checklists, and templates
