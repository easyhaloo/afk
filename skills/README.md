# Skills

AFK skills are organized below by user goal. These are **documentation categories only**: each skill remains at its existing `skills/<name>/` path and keeps its existing trigger. This index is the detailed catalog; the root README provides a shorter user-facing navigation table.

### Requirements & Product Planning

| Skill | Trigger | Description |
|---|---|---|
| [afk-grill-me](./afk-grill-me/) | `/afk-grill-me` | Requirements interview |
| [afk-grill-me-context](./afk-grill-me-context/) | `/afk-grill-me-context` | Context-aware clarification |
| [afk-to-prd](./afk-to-prd/) | `/afk-to-prd` | Create and publish an approved PRD |
| [afk-to-issues](./afk-to-issues/) | `/afk-to-issues` | Decompose requirements into backlog work items |

### Development & Technical Exploration

| Skill | Trigger | Description |
|---|---|---|
| [afk-do](./afk-do/) | `/afk-do` | Task analysis and development-workflow entry point |
| [afk-research](./afk-research/) | `/afk-research` | Investigate existing implementation and approaches |
| [afk-prototype](./afk-prototype/) | `/afk-prototype` | Validate technical feasibility |
| [afk-implement](./afk-implement/) | `/afk-implement` | Execute implementation workflow |
| [afk-diagnose](./afk-diagnose/) | `/afk-diagnose` | Diagnose reproducible failures |
| [afk-branch-migrate](./afk-branch-migrate/) | `/afk-branch-migrate` | Migrate changes across divergent branches |
| [afk-llm-dev-guide](./afk-llm-dev-guide/) | `/afk-llm-dev-guide` | LLM application architecture and context engineering |

### Testing & Quality Assurance

| Skill | Trigger | Description |
|---|---|---|
| [afk-testing](./afk-testing/) | `/afk-testing` | Test design, execution, failure diagnosis, and effectiveness review |
| [afk-change-driven-testing](./afk-change-driven-testing/) | `/afk-change-driven-testing` | Add regression tests for changed legacy business flows |
| [afk-qa](./afk-qa/) | `/afk-qa` | Independent acceptance verification before merge |
| [api-workflow](./api-workflow/) | `/api-workflow` | Multi-step API and browser-hybrid testing |

### Orchestration & Session Continuity

| Skill | Trigger | Description |
|---|---|---|
| [afk-scheduler](./afk-scheduler/) | `/afk-scheduler` | Schedule work items by dependencies |
| [afk-hand-off](./afk-hand-off/) | `/afk-hand-off` | Capture progress, decisions, blockers, and next steps |
| [session-time-analysis](./session-time-analysis/) | `/session-time-analysis` | Analyze session time distribution and bottlenecks |

### Agent Engineering & Reasoning Governance

| Skill | Trigger | Description |
|---|---|---|
| [afk-skill-craft](./afk-skill-craft/) | `/afk-skill-craft` | Create, diagnose, and refactor skills |
| [reasoning-guard](./reasoning-guard/) | `/reasoning-guard` | Detect reasoning degradation in-session |
| [reasoning-watchdog](./reasoning-watchdog/) | `/reasoning-watchdog` | Monitor reasoning quality persistently through hooks |
| [jev-agent-guard](./jev-agent-guard/) | `/jev-agent-guard` | Install checkpoints for coding agents |

### Knowledge & Engineering Governance

| Skill | Trigger | Description |
|---|---|---|
| [wiki](./wiki/) | `/wiki` | Search, read, ingest, and lint project knowledge |
| [software-complexity-governance](./software-complexity-governance/) | `/software-complexity-governance` | Assess complexity, coupling, and technical debt |

### Documentation & Format Conversion

| Skill | Trigger | Description |
|---|---|---|
| [md-to-pdf](./md-to-pdf/) | `/md-to-pdf` | Export Markdown documents to PDF |

---

Each skill directory contains:
- `SKILL.md` — skill manifest and activation instructions
- `references/` — optional methodology docs, checklists, and templates
- `scripts/` and tests — optional executable support and validation
