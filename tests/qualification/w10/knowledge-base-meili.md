# W10 knowledge-base gather with Meilisearch

Run from the checkout root on Apple Silicon macOS with Node 22.16+, Docker on `/var/run/docker.sock`, and a trusted local CLI archive and its build checksum. The runner checks the archive SHA-256, creates a temporary AFK profile, and starts a disposable Meilisearch 1.15.2 container by image digest. Both listeners bind to loopback.

```sh
node tests/qualification/w10/knowledge-base-meili.mjs release/cli/afk-darwin-arm64.tar.gz > receipt.json
```

The test HTTPS endpoint maps the AFK query scope to the Meilisearch index, forwards the prompt as `q`, passes through the limit and caller's bearer key, and returns the engine's hits as the fragment array. Meilisearch stores and indexes the documents, runs the search, and authorizes each call. The `origin` field comes from the indexed document.

Each run seeds two documents with fresh values and waits for the indexing task to succeed. It checks the exact content and origin for each query and an empty result for a missing term. A write using the search-only key must return HTTP 403. Pausing only the test container exercises the 750 ms provider timeout. Retrieval must recover on unpause. Finally, the server deletes the reader key. The same gather must surface HTTP 403 and exit 1 while a privileged control query still returns the original document. The receipt includes the synthetic content, service identity, and outcomes.
