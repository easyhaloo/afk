# Installed skill protocol qualification

The English and Chinese `2026-11-09-session-distillation` plans specify two observable contracts.

- The skill compatibility contract preserves previously installed skill editions when adding `recall-scope`. `skills/jev-agent-guard/references/host-integration.md` defines the historical key `afk-recall`. Either single declaration requires exact project, environment and named product versions for the allocated task and active run. Two declarations, invalid scope or a same-name workspace override suppress recommendation. An unmarked skill keeps its previous routing. `disable-model-invocation` preserves manual invocation.
- W05 requires an actual interpreter to compare old and new skill bytes on two inputs, rejection, recovery and inapplicability. The native probe in the plans defines observable host behavior for manual loading, resource reads and permission denial.

Run from the repository root with Node 20+ on macOS. `native-skill.mjs` uses the installed `claude` executable on `PATH` and `/usr/bin/sandbox-exec`. `skill-scope.mjs` installs the guard into a fresh temporary home using its public installer. It copies the local SDK matching the shrinkwrap version. Pass the SDK package directory as the first argument if it lives outside the default Jev installation.

```sh
node tests/qualification/w05/skill-scope.mjs > scope.json
node tests/qualification/w05/native-skill.mjs > native.json
```

The scope test invokes the registered Codex `UserPromptSubmit` command as a separate process for each case and asserts the complete response. The native test adapts the plan's `native-skill-loading-20261118` probe. Each edition runs in fresh temporary directories with a second discoverable manual skill as a loading control. A loopback model fixture observes argument expansion and tool results. It requests the approved fallback file only after receiving the host's denial for the first file. The receipt records whether the denied bytes ever reached the fixture. Each program exits nonzero on failed checks.

### Binding native loading to a saved candidate

Run the configured validator regression with the real Claude host on macOS from the repository root.

```sh
(cd packages/runtime && AFK_QUALIFY_NATIVE_SKILL=1 pnpm exec vitest run src/application/learning/proposal-validation-runtime.test.ts -t 'binds explicit skill loads')
```

The test issues the candidate-specific private execution grant before capture. The probe runs both editions of a fixed benign fixture with `alpha` and `beta`. Its loopback observer hashes the complete expanded body in the model request. It correlates the single `Read` call to its returned tool ID, exact path and one-line contents. `SKILL_LOAD_RECEIPT` contains the four observations and the runtime result. Ordinary regression runs use synthetic observations.

For an existing user-invocable skill, a saved `repository-asset` checker can select `semantic.protocol = claude-explicit-load-v1` with `adapter = skill-trace-v1`, `revision = v1`, a trusted `hostBinaryDigest` and one `{checkId, checkDigest, resource}` per normal check. `resource` is relative to the selected skill and must be in its pinned inventory. The supported substitution is literal `$ARGUMENTS` with a single ASCII token. The operator endorses the collected `skillObservation` in the private execution grant. Its `grantDigest` is SHA-256 of canonical learning JSON of the grant with `skillObservation` omitted. This covers the candidate ID, version, content and evidence digests, checker, repository revision, inventory and execution limits. The host can replay an identical endorsed observation against the same grant. Capture provenance relies on the operator who controls the grant.

`skillLoadEvidenceDigest` on `blocked/insufficient_coverage` identifies an endorsed observation matched against both prepared editions, all normal inputs and their allowed resources. A mismatch omits that digest. Frozen execution and host-owned refusal and recovery assertions are still required for candidate validation. Real-model recovery, publication and adoption need separate evidence.
