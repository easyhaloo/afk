# W10 packaged OAuth client credentials

From the checkout root on Apple Silicon macOS, use Python 3.11+, Node 24 with npm, OpenSSL with `req -addext`, tar and a trusted local CLI archive. Keep the checksum file from that build next to the archive. The only remote dependency is the public npm registry for the locked packages.

```sh
python3 tests/qualification/w10/oauth/run.py /path/to/afk-darwin-arm64.tar.gz > oauth.receipt.json
```

The runner uses a temporary HOME, event store, checkout-independent working directory and TLS trust file. It starts `oidc-provider` with its in-memory adapter and a separate report listener on ephemeral loopback HTTPS ports. Both listeners run in the harness process. The provider library implements dynamic client registration, client authentication, grant issuance, introspection, revocation and client deletion. The harness registers a disposable confidential client and configures the packaged CLI with an environment reference for its IdP-generated secret.

The product entry is `plugin invoke artifact.provider report-platform put`. The artifact consumer requests `report.write` from `credential.oauth`. The report listener checks the synthetic bytes and authorizes the bearer by querying the IdP as a separate confidential resource client. The receipt records the successful grant type, Basic authentication, client match and scope.

For natural expiry the harness resends the first upload with its original bearer after the introspected `exp`. For active revocation a second CLI invocation obtains a fresh bearer, which the harness revokes and resends before `exp`. Both resends must produce inactive introspection and HTTP 401. Finally the runner deletes the registered client at its management URI and repeats the packaged CLI invocation with the original configuration. The IdP must report `invalid_client`, the CLI must exit 1 and the resource request count must stay constant. All client and token values stay inside the disposable environment. Coverage is limited to the OAuth client-credentials flow and these two listeners within one run.
