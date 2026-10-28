# LLM Call and Agent Evaluation Pattern

Use when a feature calls a hosted or local LLM, uses tools, creates structured output, or makes a multi-step agent decision.

## Separate testing goals

- **Deterministic unit tests:** replace the model client with a fake/stub response to verify prompt construction, input mapping, parsing, retries, fallback, and downstream behavior.
- **Provider/contract integration:** verify authentication handling, request schema, response parsing, timeout, rate-limit, and error mapping with a controlled or explicitly opted-in environment.
- **Live model evaluation:** assess a representative dataset against a semantic rubric. Keep this separate from the deterministic suite because responses can vary and incur latency or cost.
- **Agent scenario tests:** assert required tool names, argument schemas, state transitions, side effects, bounded step count, and final task outcome.

## Assertions

Prefer schema validation, required facts/constraints, grounded references, policy adherence, and task-success criteria over exact whole-string matching. Exact matching is appropriate only when the output is deliberately deterministic or the contract requires a fixed value.

For agent runs, distinguish the final natural-language answer from the observable execution trace. A plausible answer does not prove that a required tool was called or that an external side effect occurred.

## Live evaluation controls

Live model tests must be explicitly enabled. Use synthetic/minimized inputs, protect credentials, bound calls and retries, and record provider/model/version, configuration, dataset/sample size, evaluator rubric, latency, and cost where available. Report variance and failed cases rather than silently retrying until green. Do not make internet access or real model calls a prerequisite for ordinary unit tests.

## Reliability and safety cases

Where relevant, test malformed structured output, refusal/fallback behavior, tool errors, context truncation, timeout, rate limit, duplicate tool invocation, prompt-injection-like untrusted inputs, and sensitive-data handling. Select scenarios based on the system's actual contract and risk.
