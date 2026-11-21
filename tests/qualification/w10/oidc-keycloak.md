# W10 OIDC token exchange with Keycloak

From the checkout root, use Python 3.11+, Node compatible with the archive, OpenSSL with `req -addext`, and Docker reachable on `/var/run/docker.sock`. Supply a trusted macOS CLI tarball and its adjacent `.sha256` file. The runner uses the pinned Keycloak 26.4.7 image, a fresh realm, generated RSA client assertions and a synthetic service-account subject token. Docker may pull the image on the first run.

```sh
python3 tests/qualification/w10/oidc-keycloak.py /path/to/afk-darwin-arm64.tar.gz > oidc.receipt.json
jq -e '.release.version == "0.2.159" and (.cases | length == 10)' oidc.receipt.json
```

The [recorded run](oidc-keycloak.receipt.json) used the darwin-arm64 0.2.159 package (SHA-256 `957e237b6bbbbe651c8e259b75e9b8775a43619c2ce3c1d8f003fdecde3c8e72`). The runner checks the adjacent checksum and compares the extracted CLI's `--version` with its release manifest. Run the two commands in order and check each exit status. The optional `jq` check confirms the expected version and case count.

Each packaged `plugin invoke artifact.provider report-platform put` resolves its `credential.oidc` reference through discovery and an optional endpoint pin. The HTTPS listener records discovery and token statuses and forwards the requests to Keycloak's loopback-published port. Keycloak issues the subject, authenticates the signed assertion, processes the access-token exchange and answers introspection. The test report service accepts the actual upload after checking the bearer, issuer, audience, scope, client, expiry and payload bytes.

The receipt distinguishes an assertion's issuer audience from the requested report audience. It includes the wrong pin, wrong assertion audience, expired assertion and ungranted target. Disabling and restoring the target client tests authorization for **new exchanges**. The client explicitly revokes a second accepted bearer at the Keycloak revocation endpoint. The report service introspects that bearer and rejects it with HTTP 401 before its expiry. A new exchange then succeeds. A separate replay checks the first bearer after its own expiry. These observations cover the exchange path with an imported X.509 client certificate and the test resource's online introspection policy. The harness signs assertions, the IdP evaluates claims and authorization, and the resource decides whether to accept the report. Immediate invalidation of previously issued bearers on client disablement and interactive end-user authentication are outside this run's coverage.

The JSON receipt appears on stdout after cleanup. Stderr carries per-invocation status and request counts. The runner removes its disposable container and temporary profile on normal completion and handled failures.
