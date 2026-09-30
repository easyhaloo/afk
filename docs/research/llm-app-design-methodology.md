# Skill-Driven LLM Applications That Stay Governable

## Executive Summary

- **Boundary First**: Anthropic distinguishes workflows, where code defines the path, from agents, where the LLM dynamically directs process and tool use [6]. OpenAI recommends agents for complex decisions, hard-to-maintain rules, and unstructured data, and says deterministic automation may be enough otherwise [18]. -> Start with a workflow and promote only the uncertain step to a bounded agent skill.
- **Skills as Contracts**: Anthropic's production research system gives each subagent an objective, output format, tool guidance, and clear task boundaries [14]. -> Make every business capability a versioned skill manifest with schemas, policy, owner, context rules, evaluator, and trace identity.
- **Approval as State**: OpenAI's HITL flow declares approval-required tools, returns interruptions, serializes RunState, and resumes after approval or rejection [3]. LangGraph likewise persists graph state while an interrupt waits for external input [15]. -> Treat human review as durable control flow, never as an informal prompt instruction.
- **Context as a Budget**: Anthropic describes context as finite, with an attention budget and diminishing returns, and recommends the smallest high-signal token set [2]. -> Use just-in-time retrieval, explicit budgets, provenance, compaction, and short-lived context by default.
- **Observability as Trajectory**: OpenAI tracing records LLM generations, tool calls, handoffs, guardrails, and custom events, and exposes them for development and production monitoring [8]. OpenTelemetry describes standardized metrics, traces, and logs to compare agent frameworks [16]. -> Trace each skill run from intent to authorization to side effect, not merely the final answer.
- **Authorization at the Skill Boundary**: NIST's NCCoE identifies standards-based identity, management, and authorization for software and AI agents as an open engineering problem [7]. OpenAI also couples guardrails with authentication, authorization, and strict access controls [18]. -> Give each skill task-scoped capabilities and audit every proposed, denied, approved, and executed action.
- **Version the Whole Contract**: LangSmith supports curated-dataset comparisons, regression detection, online production evaluations, and calibration of LLM judges with human feedback [5]. OpenRouter's presets demonstrate separating provider routing, model selection, system prompts, and parameters from code [30]. -> Release prompt, model, skill schema, retrieval, policy, and evaluator as a compatible bundle.
- **Human Review Where Irreversible**: OpenAI recommends intervention when failure thresholds are exceeded and for sensitive, irreversible, or high-stakes actions [18]. -> Automate reversible preparation; reserve approval for commitments, privilege changes, external messages, and destructive writes.

## 1. The Skill-Driven Operating Model

The primary unit of design should be a business skill, not an agent and not a vendor SDK. A skill is a bounded capability such as `refund_order`, `summarize_contract`, `triage_incident`, or `research_market`. Its implementation may be a deterministic function, a workflow, a bounded agent loop, or a human-assisted process. The caller should not need to know which implementation was selected.

A useful skill manifest is:

```text
SkillSpec {
  id, owner, purpose, risk_class
  input_schema, output_schema, error_schema
  read_capabilities, write_capabilities
  context_policy, retention_policy
  approval_policy, escalation_policy
  prompt_version, model_policy, tool_versions
  evaluator, SLOs, trace_fields
}
```

This makes the skill a contract between business, engineering, security, and operations. The owner defines the business outcome and unacceptable behavior. Engineering owns the handler and adapters. Security owns capability and data policy. Operations owns SLOs, alerts, rollback, and incident review. The skill registry becomes the inventory for architecture review: every entry has a risk class, an owner, a current version, and a reason for any autonomy.

The implementation pipeline should be explicit: `intent -> skill selection -> authorization -> context assembly -> plan or workflow -> validation -> approval if required -> side effect -> outcome verification -> trace and evaluation`. The agent, if present, controls only the planning portion that the skill manifest permits. The policy engine and deterministic adapters remain outside the model's authority.

Anthropic's Research system is a concrete case. A lead agent decomposes a query, describes the objective, output format, tools, and boundaries for each subagent, and then synthesizes the results [14]. It runs three to five subagents in parallel and reports that the change cut complex-query research time by up to 90 percent [14]. The design works because the subagents are not free-form employees: each has a bounded assignment and returns a defined artifact. Anthropic also reports that small errors can compound and derail an agentic trajectory, and that the prototype-to-production gap is often wider than expected [14].

**Decision:** Create a registry entry and contract test before creating an agent. If a capability cannot state its input, output, authority, approval boundary, owner, and evaluator, it is not ready for autonomous execution.

## 2. Choosing Workflows, Agents, and Hybrids

Anthropic's distinction is operational: a workflow uses predefined code paths, while an agent dynamically directs its own process and tool use [6]. OpenAI's suitability test is similarly practical: use agents where decisions are complex, rules are difficult to maintain, or data is unstructured; use deterministic automation where those conditions do not apply [18]. This is a business-boundary decision, not a model-preference decision.

| Dimension | Deterministic workflow | Bounded agent skill | Autonomous agent |
|---|---|---|---|
| Path | Predefined sequence and branches | Workflow shell with model-controlled subtask | Model chooses next steps dynamically |
| Best fit | Stable rules and predictable inputs | Uncertain classification, retrieval, or drafting | Open-ended, exploratory, reversible work |
| Authority | Code and policy | Model can read or propose within an allowlist | Model selects tools and path within a broad budget |
| Main control | Tests and state transitions | Schema validation, step limits, approval gates | Trajectory monitoring, budgets, sandboxing, human escalation |
| Failure cost | Usually visible and repeatable | Contained to one skill | Can compound across steps [14] |
| Default recommendation | First choice | Preferred promotion target | Exception requiring evidence |

Use a four-question gate for each candidate capability. First, is the path stable enough to encode? If yes, use a workflow. Second, is uncertainty limited to a subtask such as extracting fields, selecting a document, or drafting a response? If yes, use a bounded agent inside a workflow. Third, are actions read-only or reversible? If no, put the agent before an approval or deterministic commit step. Fourth, can success be expressed as a typed result and evaluated from a replayable case? If not, do not widen autonomy yet.

A strong hybrid pattern is `workflow outer shell, agent inner loop`. The shell authenticates the user, loads policy, creates the trace, sets a time and token budget, and owns retries and commits. The inner agent may select among read-only retrieval skills, ask for missing information, or generate a structured proposal. The shell validates the proposal, asks for approval when needed, and invokes the write adapter. OpenAI recommends starting with a single agent and moving to multiple agents only when needed, including when the number of tools becomes large [18].

Anthropic's Research system illustrates when a more autonomous boundary can pay off: the search space is open-ended, subtasks can run in parallel, and the lead can decide whether more research is needed [14]. It also illustrates the limit: parallelism increases the number of interacting trajectories, so tool design, prompts, testing, and operational practices must compensate [14].

**Decision:** Score each skill on path stability, uncertainty, reversibility, consequence, tool breadth, and evaluability. Begin at the left side of the table and move right only when measured value exceeds the added control burden.

## 3. HITL as Durable Control Flow

Human-in-the-loop design should answer four questions: what event triggers review, what exactly does the reviewer see, what decisions are possible, and how does execution resume safely? The human should approve a concrete action proposal, not a vague statement that an agent is trustworthy.

| Pattern | Trigger | Human decision | Resume behavior |
|---|---|---|---|
| Pre-action approval | Sensitive or irreversible tool call | Approve, reject, or edit target and parameters | Revalidate policy and execute only the approved action |
| Draft review | External message, legal text, or material recommendation | Edit or accept the proposed artifact | Send or publish the approved artifact with a new hash |
| Exception escalation | Confidence, validation, or retry threshold exceeded | Resolve ambiguity or take over | Continue from a durable checkpoint with the decision recorded |
| Sampled quality review | Low-risk automated work | Accept, correct, or label a failure | Feed the label into evaluation and policy tuning |

Use a state machine such as `PROPOSED -> POLICY_CHECK -> WAITING_APPROVAL -> APPROVED/REJECTED/EDITED -> EXECUTE -> VERIFY`. Store a review packet containing the run ID, requesting user, skill and policy versions, intended target, proposed diff, evidence references, risk reason, expiry, and allowed decision types. On approval, bind the approval to the exact proposal hash and resource scope. If the proposal changes, require a new approval. On timeout, expire the capability or escalate; do not silently continue.

LangChain's HITL middleware checks each tool call against a configurable policy, pauses when a model proposes an action that needs review, and issues an interrupt [17]. Its examples include writing a file or executing SQL [17], which is a useful boundary: the agent may prepare an action, but the side effect can be held for review. LangGraph interrupts save graph state and wait until the application resumes execution [15]. OpenAI's SDK follows the same durable idea: tools declare approval needs, the result exposes pending interruptions, and serialized RunState can resume after approval or rejection [3].

A production implementation should separate review classes. Low-risk requests can use auto-approval or sampled review. Medium-risk requests can use one reviewer with a short expiry. High-risk requests require step-up authentication, a second approver, or a fully deterministic operator flow. Approval is not a substitute for authorization: the policy engine must still check identity, tenant, resource, and current state at execution time.

The OpenAI approval flow is a concrete case of the design choice. Its entity is the tool, not the entire conversation: only the sensitive action pauses, while the run remains resumable [4]. That keeps human effort proportional to risk and avoids forcing a person to supervise harmless reasoning.

**Decision:** Place HITL at the narrowest irreversible boundary, persist the state and evidence required to resume, and make approval specific to a versioned action rather than to an entire chat session.

## 4. A Maintainable Code and Configuration Topology

The codebase should make it difficult for a prompt to bypass domain rules, for a skill to embed provider-specific code, or for production secrets to enter a prompt or trace. A practical topology is:

```text
app/
  domain/                 deterministic business rules and entities
  skills/
    refund_order/
      contract.py         typed inputs, outputs, and errors
      handler.py          orchestration of the capability
      context.py          authorized context assembly
      policy.py           risk and approval rules
      prompts/            versioned instruction references
      evaluators/         skill-specific test and eval cases
  orchestration/          workflows, state machines, retries, checkpoints
  llm/
    client.py             provider-neutral model port
    providers/            OpenAI, Anthropic, or other adapters
    structured_output.py  schema validation and repair policy
  tools/                  side-effecting adapters with explicit capabilities
  config/                 typed non-secret settings and environment mapping
  security/               identity, policy decisions, redaction, audit events
  telemetry/              traces, metrics, logs, sampling, correlation IDs
  tests/                  unit, contract, replay, security, and evaluation tests
```

The dependency rule is inward: domain code does not import an LLM SDK; skills depend on an `LLMClient` port and tool interfaces; provider adapters implement those ports; orchestration calls skills but does not own business rules. Prompts are data with an owner and version, not scattered string literals. Model parameters, routing, temperature, timeout, and retry policy are configuration or policy, not hidden inside a skill handler.

This is consistent with the Twelve-Factor config boundary: configuration is what varies between deploys, including backing-service handles and external-service credentials, and the guidance says to store it in the environment [28]. OpenRouter's presets provide a concrete product example of the same seam: provider routing, model selection, system prompts, and parameters can be managed separately from code [30]. Use a secret manager for secrets; environment variables should hold references or deployment-specific values, never a prompt's unreviewed business policy.

Tests follow the same seams. Unit-test deterministic rules. Contract-test every skill schema and authorization decision. Mock the model port for orchestration tests. Run provider compatibility tests against a small fixed set. Replay traces and golden cases for prompt or model changes. Test tool adapters with idempotency, authorization, and failure cases. This organization makes a model swap or prompt experiment a controlled adapter or data change instead of a cross-cutting rewrite.

OpenRouter's preset pattern is a useful case study because it separates the volatile model configuration from application code while retaining a request-level reference to that configuration [30]. The lesson is broader than the product: configuration separation is valuable only when the selected version is still captured in the trace and release manifest.

**Decision:** Enforce provider neutrality below the skill layer, keep prompts and model settings versioned outside business logic, and make every side effect pass through a capability-bearing adapter.

## 5. Context and Data Governance by Construction

Context is not a free input buffer. Anthropic describes it as a finite resource with diminishing marginal returns and an attention budget [2]. The recommended objective is the smallest set of high-signal tokens that supports the desired outcome [2]. Design context as a governed packet with an explicit budget, provenance, classification, purpose, and expiry.

| Context layer | Contents | Control | Default lifetime |
|---|---|---|---|
| Instruction | System rules and skill policy | Version, owner, approval, injection resistance | Release lifetime |
| Identity | User, tenant, role, purpose, authorization claims | Server-derived; never model-authored | Run lifetime |
| Task state | User intent, workflow state, prior decisions | Typed schema and checkpoint | Run or case lifetime |
| Evidence | Retrieved records, documents, tool results | Source, access check, timestamp, confidence | Step or run lifetime |
| Memory | Durable preferences or notes | Explicit opt-in, retention and deletion policy | Policy-defined |
| Tool surface | Only tools allowed for this skill and state | Capability manifest and schema | Step lifetime |

Prefer just-in-time retrieval over loading an entire corpus. Anthropic describes keeping lightweight identifiers such as file paths, stored queries, and links, then loading data at runtime through tools; this supports progressive disclosure but can be slower than precomputed retrieval [2]. For long tasks, use compaction to summarize decisions and unresolved issues, structured notes outside the context window, or focused subagents that return a short distilled result [2]. Preserve source references and critical decisions through compaction; never let a summary silently become the only copy of regulated evidence.

Data governance should be implemented in the context assembler, not left to the prompt. Classify data before retrieval. Filter by tenant, purpose, role, and field sensitivity. Mask secrets and unnecessary personal data. Attach source and retention metadata. Deny memory writes unless the skill explicitly permits them. Keep raw documents in the system of record and pass a minimal view to the model. Redact or hash sensitive prompt and tool fields before traces. Define deletion and correction behavior for memory, caches, embeddings, and derived summaries.

Anthropic's multi-agent Research system shows the operational reason for context isolation. The lead preserves its plan because a context window can exceed 200,000 tokens and be truncated, while subagents work in separate windows and return findings to the lead [14]. The result is not merely more capacity; it is a boundary for what each worker is allowed to see. That same boundary can enforce tenant isolation and reduce accidental disclosure.

Context governance has a real tension: just-in-time exploration reduces the initial data exposure, but it introduces more tool calls and a harder-to-replay trajectory. Store identifiers, retrieval queries, access decisions, source hashes, and output references so an investigator can reconstruct what was available without retaining every sensitive token.

**Decision:** Make context assembly a typed, policy-enforcing service with budgets and provenance. Treat memory, caches, embeddings, summaries, and traces as governed data stores, not as harmless implementation details.

## 6. Tracing, Evaluation, and Monitoring as a Control Loop

A useful trace is a causal record of a skill run. Start with a root run span and nest skill selection, policy checks, context retrieval, model calls, tool proposals, approvals, retries, handoffs, and outcome verification. OpenAI's tracing implementation records LLM generations, tool calls, handoffs, guardrails, and custom events, and makes traces available for debugging and monitoring in development and production [8]. OpenTelemetry's agent-observability work argues for standardized metrics, traces, and logs so different frameworks can be integrated and compared [16].

| Event | Minimum fields | Operational use |
|---|---|---|
| Run | run ID, tenant, user, skill/version, intent class | Correlate the whole trajectory |
| Model call | provider, model, prompt version, latency, tokens, cost, status | Detect drift, cost spikes, and provider failures |
| Retrieval | source IDs, query hash, access decision, timestamp | Reproduce grounding and investigate leakage |
| Tool proposal | tool/version, sanitized arguments, policy result, risk class | Audit intent before side effect |
| Approval | reviewer, decision, proposal hash, timestamp, expiry | Prove who authorized what |
| Outcome | schema validity, business result, error, evaluator scores | Measure task completion and regression |

Use structured events rather than free-form logs. Redact prompt and tool fields according to the data classification policy. Keep correlation IDs through queues and human review. Sample low-risk successful runs if volume requires it, but retain complete traces for failures, denials, escalations, approvals, and high-risk actions. Do not treat a trace as a chain-of-thought record; capture inputs, outputs, tool arguments, decisions, and timings needed for operations and audit.

Evaluation closes the loop. Maintain a skill-specific dataset containing normal cases, boundary cases, adversarial inputs, authorization failures, tool errors, and previously observed incidents. Score both result and trajectory: schema validity, task completion, grounding, safety, policy compliance, approval correctness, latency, and cost. LangSmith describes curated-dataset evaluation for comparing agent versions and catching regressions, plus online evaluation of production interactions and human calibration of LLM judges [5].

The OpenAI Agents SDK is a concrete observability case: the trace includes the model and control events that explain how the agent arrived at an outcome, rather than recording only the final response [8]. A skill-driven implementation should add business fields that the generic runtime cannot know, such as refund amount, affected account, policy rule, or incident severity.

Alert on patterns, not isolated model oddities: rising tool denials, repeated repair loops, approval timeout, high-risk actions without an approval event, retrieval from an unauthorized source, invalid output schemas, cost per successful task, and human override rate. Every alert should link to a replayable trace and an owner.

**Decision:** Define the trace schema before production launch and make evaluation metrics part of the skill contract. If a run cannot explain its authority, evidence, actions, and outcome, it is not operationally ready.

## 7. Permission Auditing at the Skill Boundary

Treat the agent, the human user, and the calling application as distinct principals. A user may be allowed to request a skill without allowing the model to perform every action that the skill can technically reach. The permission decision should bind together user identity, tenant, purpose, skill version, resource, action, context, and time.

NIST's NCCoE is explicitly exploring standards-based ways to identify, manage, and authorize access and actions taken by software agents, including AI [7]. OpenAI's guidance reinforces the application-security boundary: guardrails should be combined with authentication, authorization, strict access controls, and ordinary security measures [18]. OWASP describes its 2026 agentic framework as identifying critical security risks for autonomous and agentic AI systems [10]. Together, these sources support treating permission auditing as a first-class architecture concern rather than a prompt-writing task.

| Capability class | Example | Default policy | Audit evidence |
|---|---|---|---|
| Read | Search a permitted customer record | Allow if identity and tenant match | Query, resource, source, decision |
| Analyze | Classify or summarize retrieved data | Allow within data-purpose policy | Input class, model, output schema |
| Draft | Prepare an email, SQL, or change proposal | Allow, but do not commit | Proposed diff and risk score |
| Commit | Send, update, refund, or delete | Step-up approval or deterministic rule | Approval hash, actor, target, result |
| Admin | Change permissions, policies, or integrations | Separate operator flow and dual control | Two identities, ticket, before/after state |

Give each skill a capability manifest with read scopes, write scopes, resource filters, maximum amounts or counts, allowed tools, network destinations, and expiry. Use least authority at three levels: the tool list exposed to the model, the service credential available to the adapter, and the policy decision for each action. Keep credentials out of prompts. Split read and write tools so a model cannot turn a retrieval capability into a mutation capability through argument manipulation.

Audit both intent and execution. Record proposed actions, policy inputs, allow or deny decisions, approval decisions, actual adapter calls, result status, and any mismatch between proposal and execution. Run a permission audit at build time by linting manifests and schemas; at deploy time by checking compatibility with role and resource policy; and at runtime by testing denials, expiry, tenant boundaries, and replay. Reconcile observed tool calls against the declared manifest. A break-glass path should be explicit, time-limited, authenticated, and reviewed after use.

The LangChain HITL example of pausing before a file write or SQL execution is a concrete boundary between preparation and side effect [17]. The NIST NCCoE project is the corresponding governance case: it treats agent identity and action authorization as a standards problem because an agent can act across systems on behalf of a principal [7].

**Decision:** Authorize actions at execution time using a central policy decision, constrain credentials below the model, and make the audit record sufficient to answer who requested, who approved, what was proposed, what was executed, and what changed.

## 8. Versioned Delivery and Safe Iteration

An LLM release is not just a new model or a changed prompt. The effective behavior is the combination of skill code, prompt, model and provider settings, tool schemas, retrieval configuration, context policy, memory behavior, authorization policy, evaluator, and data contract. Give the combination a release ID and record it in every trace.

| Artifact | Version with | Compatibility test | Rollback unit |
|---|---|---|---|
| Skill contract | Input, output, errors, risk class | Consumer and schema tests | Previous compatible contract |
| Prompt and model policy | Prompt hash, model, parameters, routing | Golden cases and safety cases | Previous prompt/model bundle |
| Tools and retrieval | Schema, adapter, index, source policy | Contract, access, and grounding tests | Previous tool/index bundle |
| Policy and approval | Rules, roles, thresholds, escalation | Allow/deny and HITL cases | Previous policy revision |
| Evaluator | Dataset, rubric, judge calibration | Agreement and regression checks | Previous quality gate |

Use a release pipeline with seven gates. (1) Add or update golden cases, including the incident that motivated the change. (2) Run deterministic unit, schema, authorization, and adapter tests. (3) Replay representative traces with side effects disabled. (4) Compare candidate and baseline on task success, safety, grounding, schema validity, latency, cost, denial rate, and human override. (5) Obtain domain-owner approval for changed business behavior. (6) Canary by tenant, skill, or traffic slice, with a kill switch. (7) Promote only when online metrics remain within bounds; otherwise roll back the bundle and preserve the failing traces.

Separate fast-changing prompt experiments from slow-changing policy and contract changes, but never let them become untracked. OpenRouter's preset mechanism shows how model routing and system prompts can be separated from code [30]. LangSmith's curated datasets and online evaluations show how that separation can still be compared against a baseline and monitored after release [5]. The registry must therefore support aliases such as `staging`, `canary`, and `production`, immutable versions, diff review, owner approval, and a deployment record.

Anthropic's production account supplies the failure case. It warns that small agent errors can compound into divergent trajectories and that the gap from prototype to production is often larger than anticipated [14]. This argues for trajectory regression tests, not merely a few successful prompt examples. A release that improves answer quality but increases unauthorized tool proposals is not an improvement.

**Decision:** Promote immutable bundles, not isolated prompts. Require replayable evals and a staged rollout for any change that can alter authority, data access, side effects, or business decisions.

## 9. Synthesis: One Method for Governable Autonomy

The central recommendation is a workflow-first, skill-centered architecture. It preserves deterministic control where the business path is known, introduces agent autonomy only inside a bounded capability, and makes human approval, context, permissions, traces, and releases part of the same contract.

| Architecture choice | Mechanism | Scope | Trade-off | Best evidence or use |
|---|---|---|---|---|
| Workflow-first | Code owns sequence; model fills bounded fields | Stable, repeatable business process | Lowest adaptability, strongest control | OpenAI says deterministic automation can suffice when agent conditions are absent [18] |
| Bounded skill | Agent explores or proposes inside a typed shell | Uncertain subtask with limited tools | More value and some trajectory risk | OpenAI recommends tools, guardrails, and a single agent before expansion [18] |
| Orchestrator-worker | Lead decomposes work and parallel workers return artifacts | Open-ended research or analysis | Parallel capacity and speed versus compounded error | Anthropic reports three to five parallel subagents and up to 90 percent time reduction in complex research [14] |
| Durable human-assisted flow | Runtime pauses, persists state, and resumes after a decision | Consequential or ambiguous actions | Safety and accountability versus latency | OpenAI and LangGraph both implement interruption and resumable state [3][15] |

Several non-obvious tensions shape the design. Just-in-time context limits exposure and supports progressive disclosure, but it is slower and harder to reproduce than precomputed retrieval [2]. Persistent memory helps long-horizon work, but it creates another governed data store and another permission boundary. Parallel subagents improve throughput, but they increase the number of tool calls, traces, and possible failure paths [14]. Rich observability improves accountability, but sensitive fields must be redacted, hashed, or retained under the same policy as the source data.

There is also a velocity tension. Separating prompts and model routing from code enables faster iteration [30], while unbundled changes can produce prompt-policy-schema drift. The answer is not to freeze prompts in code; it is to version the whole behavior bundle and gate it with curated and online evaluations [5]. HITL reduces the consequence of uncertainty, but approval queues can become a new bottleneck; use risk-based sampling and automate reversible work rather than sending every task to a person.

Adopt in this order: first inventory skills and classify risk; second define contracts and deterministic adapters; third add context and permission policy; fourth instrument complete traces; fifth introduce bounded agent steps; sixth add durable HITL at irreversible boundaries; seventh build replayable evals and canary releases; finally widen autonomy only when outcome and control metrics support it. The result is skill-driven architecture: business capabilities remain stable while models, prompts, retrieval, and orchestration evolve behind governed interfaces.

**Decision:** Make autonomy an earned property of a skill. The promotion test is not whether an agent can complete a demo; it is whether the organization can constrain, observe, authorize, evaluate, and roll back the capability in production.

## References

1. *Building Effective AI Agents \ Anthropic*. https://www.anthropic.com/engineering/building-effective-agents
2. *Effective context engineering for AI agents \ Anthropic*. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
3. *Human-in-the-loop - OpenAI Agents SDK*. https://openai.github.io/openai-agents-python/human_in_the_loop
4. *Human-in-the-loop | OpenAI Agents SDK*. https://openai.github.io/openai-agents-js/guides/human-in-the-loop
5. *LangSmith: AI Agent & LLM Model Evaluation Platform*. http://langchain.com/langsmith/evaluation
6. *Building Effective AI Agents \ Anthropic*. http://anthropic.com/research/building-effective-agents
7. *Software and AI Agent Identity and Authorization*. https://www.nccoe.nist.gov/projects/software-and-ai-agent-identity-and-authorization
8. *Tracing - OpenAI Agents SDK*. http://openai.github.io/openai-agents-python/tracing
9. *Specification Model Context Protocol https://modelcontextprotocol.io › ...*. https://modelcontextprotocol.io/specification/2025-06-18
10. *OWASP Top 10 for Agentic Applications for 2026*. https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026
11. *The Twelve-Factor App*. https://12factor.net/
12. *Tools - Model Context Protocol*. https://modelcontextprotocol.io/specification/draft/server/tools
13. *http://owasp.org/www-project-top-10-for-large-language-model-applications*. http://owasp.org/www-project-top-10-for-large-language-model-applications
14. *http://anthropic.com/engineering/multi-agent-research-system*. http://anthropic.com/engineering/multi-agent-research-system
15. *Interrupts - Docs by LangChain*. https://docs.langchain.com/oss/python/langgraph/interrupts
16. *AI Agent Observability - Evolving Standards and Best ...*. https://opentelemetry.io/blog/2025/ai-agent-observability/
17. *Human-in-the-loop - Docs by LangChain*. https://docs.langchain.com/oss/python/langchain/human-in-the-loop
18. *http://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents*. http://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents
19. *LangGraph overview*. https://docs.langchain.com/oss/python/langgraph/overview
20. *Prompt optimizer | OpenAI API*. https://platform.openai.com/docs/guides/prompt-optimizer
21. *Getting started with datasets | OpenAI API*. https://platform.openai.com/docs/guides/evaluation-getting-started
22. *Working with evals | OpenAI API*. https://platform.openai.com/docs/guides/evals
23. *Agentic AI - OWASP Lists Threats and Mitigations*. https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations
24. *Prompt Registry for LLMs & Agents | MLflow Agent Platform*. https://mlflow.org/prompt-registry
25. *The Twelve-Factor App *. https://12factor.net/dependencies
26. *The Twelve-Factor App *. https://12factor.net/admin-processes
27. *The Twelve-Factor App *. https://12factor.net/logs
28. *The Twelve-Factor App *. https://12factor.net/config
29. *The Twelve-Factor App *. https://12factor.net/build-release-run
30. *Presets*. https://openrouter.ai/docs/guides/features/presets
31. *Artificial Intelligence Risk Management Framework: Generative Artificial Intelligence Profile*. https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf
