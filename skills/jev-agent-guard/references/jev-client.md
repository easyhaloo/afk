# Native Jev SDK

The guard uses TypeSafe's official JavaScript SDK:

- Package: `@typesafe-ai/sdk`
- Minimum Node.js: 20
- Credential: `TYPESAFE_API_KEY`
- Client: `TypeSafeClient`
- Primitives: `choice`, `noul`, and `score`

Install the dependency from this Skill directory before running the scripts.
The Skill's local `package.json` keeps the SDK independent from the AFK
application.

## Direct use from an internal script

Import `scripts/jev-client.mjs` and call `askJev`, `decideChoice`,
`decideNoul`, or `decideScore`. The facade only creates typed questions and
calls `TypeSafeClient.systemOne`; it does not implement HTTP, retries, response
parsing, or authentication.

The native SDK reads `TYPESAFE_API_KEY` from the process environment. Never
write the key to a repository file, command argument, audit record, or log.

## CLI bridge input

`scripts/jev.mjs` reads JSON from stdin or `--input`. The bridge converts the
JSON question specification into native SDK question objects:

```json
{
  "state": { "task": "repair the login timeout" },
  "questions": {
    "route": {
      "type": "choice",
      "instructions": "Which workflow should handle this task?",
      "criteria": {
        "debug": "The task needs root-cause debugging.",
        "implementation": "The task needs a feature implementation.",
        "review": "The task needs a code review."
      }
    },
    "risky": {
      "type": "noul",
      "instructions": "Could this action expose credentials?"
    },
    "severity": {
      "type": "score",
      "instructions": "How risky is this action?",
      "levels": ["safe", "review", "dangerous"]
    }
  }
}
```

Related questions should be batched into one `systemOne` request. The guard
must apply local policy first and call Jev only for ambiguous, high-value
semantic decisions.

## Error and fallback behavior

A missing key, SDK error, timeout, or malformed provider response is not an
approval. High-risk actions must fail closed; ordinary actions must fall back
to the host's native permission flow.
