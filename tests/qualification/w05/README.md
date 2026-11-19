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

The synthetic runs qualify host behavior and scoped routing. Production `skill-trace-v1` still needs trusted binding of the frozen execution, loaded resources, authorization and host-owned expectations. Real-model recovery, managed publication, installation after human merge, cross-agent adoption and rollback require separate evidence.
