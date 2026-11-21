# W10 macOS system keychain

Run from the checkout root on Apple Silicon macOS with Python 3.11+, Xcode command line tools, and Node 22.16+ on `PATH`.

```sh
python3 tests/qualification/w10/system-keychain.py release/cli/afk-darwin-arm64.tar.gz
```

The runner verifies the archive against the checksum from the same trusted local build and executes the extracted CLI from a fresh temporary home. A native helper creates a private file keychain using `SecKeychainCreate` with a random in-memory password. The runner seeds a random generic password using a pipe to `security -i`. The configured `command` wrapper accepts only the expected service and account arguments and appends the absolute private keychain path before executing `/usr/bin/security`. This covers the configured-command variant of `credential.system-keychain`. The stock command uses the user's search list.

The selected `context.knowledge-base` consumer sends an authenticated gather request to a loopback HTTPS verifier. The verifier checks the exact token, method, path and query. After deleting the synthetic item the runner repeats the gather in a fresh CLI process and checks for the public credential error and zero additional HTTP requests. The HTTPS verifier is a test fixture. Independent knowledge-base service qualification remains a separate matrix row.

The JSON receipt records outcomes only. The runner compares user preference metadata before creation, after creation and after cleanup. On this host `login-keychain -d user` returned exit 1 with empty output. Its comparison covers that return state. All item operations target the private file. The temporary directory contains the complete AFK profile, keychain and TLS files and is removed at exit.
