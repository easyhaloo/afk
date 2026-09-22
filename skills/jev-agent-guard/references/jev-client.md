# Jev Agent Guard

The Skill includes a dependency-free Jev client at
`scripts/jev-client.mjs`. It can be imported directly by internal scripts and
uses Node.js 18+ `fetch`; no npm dependency is required.

## Client contract

- `createJevClient(options)` creates a client.
- `client.ask({ state, questions, metadata })` sends one batched typed request.
- `client.choice({ state, prompt, options })` asks a typed choice question.
- `client.noul({ state, prompt })` asks a typed yes/no-style question.
- `redact(value)` removes common bearer tokens, secrets, and private keys before transmission.

Configuration is environment-only by default:

- `TYPESAFE_API_KEY`: required for live requests
- `TYPESAFE_ENDPOINT`: optional endpoint override
- `JEV_MODEL`: optional model override, default `jev-latest`

The client does not make policy decisions. Callers must apply local policy,
redact input, batch related questions, and treat provider errors as
non-approval. Do not send credentials, complete environment files, or
unrelated private source.

## Direct CLI bridge

`scripts/jev.mjs` accepts a JSON document from stdin or `--input`. The document
contains `state`, `questions`, and optional `metadata`, and the response is
JSON. It is intended for adapters and diagnostics; the guard should prefer
local rules and call it only for ambiguous, high-value judgments.
