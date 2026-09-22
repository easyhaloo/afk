# Native Jev SDK

The guard uses TypeSafe's official JavaScript SDK instead of a custom HTTP
transport:

- Package: `@typesafe-ai/sdk`
- Minimum Node.js: 20
- Credential: `TYPESAFE_API_KEY`
- Client: `TypeSafeClient`
- Primitives: `choice`, `noul`, and `score`

Install the dependency from this Skill directory before running the scripts.
The Skill's local `package.json` pins the official SDK dependency; it is not a
dependency of the AFK application.

## Direct use from an internal script

Import `scripts/jev-client.mjs` and call `askJev`, `decideChoice`,
`decideNoul`, or `decideScore`. The facade only creates typed questions and
calls `TypeSafeClient.systemOne`; it does not implement HTTP, retries, response
parsing, or authentication.

The native SDK reads `TYPESAFE_API_KEY` from the process environment. Never
write the key to a repository file, command argument, audit record, or log.

## CLI bridge input

The `scripts/jev.mjs` bridge reads JSON from stdin or `--input`:

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
    }
  }
}
```

For internal callers, prefer constructing questions with the official SDK
helpers rather than hand-writing serialized question objects. Batch related
questions in one `systemOne` request and call Jev only when local rules cannot
resolve the decision.

## Error and fallback behavior

A missing key, SDK error, timeout, or malformed provider response is not an
approval. High-risk actions must fail closed; ordinary actions must fall back
to the host's native permission flow.
