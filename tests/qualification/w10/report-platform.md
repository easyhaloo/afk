# W10 Grafana snapshot qualification

Run from the repository root on macOS or Linux with Python 3.8+, Node.js 22.16+, and Docker Engine accessible through a local Unix socket. Archive installation also uses Bash and tar. The two input forms were exercised with AFK 0.2.148 on macOS arm64.

Cache the pinned official Grafana 7.5.16 image once. Use the same socket for the pull and the test. Pass `--socket /path/to/docker.sock` to the test for a non-default socket.

```sh
docker_config=$(mktemp -d)
docker --config "$docker_config" -H unix:///var/run/docker.sock pull \
  docker.io/grafana/grafana@sha256:9b7b1d9a1deadbe6fed74416d58db47f8af31b5cee214cfb659f89e6dda3f716
rmdir "$docker_config"
```

Supply either the installed executable or the host's release archive with its adjacent `.tar.gz.sha256`. The latter goes through the repository's offline installer. Each invocation writes a JSON receipt to stdout and exits zero on `PASS`.

```sh
python3 tests/qualification/w10/report-platform.py /path/to/installed/afk > installed.json
python3 tests/qualification/w10/report-platform.py /path/to/afk-darwin-arm64.tar.gz > archive.json
```

The harness uses a temporary home and Docker configuration. Grafana runs with `--network none`. A host listener on `127.0.0.1` forwards bytes through `docker exec -i` and the image's `nc` to Grafana's container loopback. AFK posts a snapshot containing a synthetic JUnit report. An independent HTTP client opens the returned URI, retrieves the snapshot by its key, and compares report bytes and SHA-256 digests.

The receipt records a closed-port failure, HTTP 400 for malformed JSON, and HTTP 401 for the original valid payload after disabling public snapshots and restarting Grafana. Each rejection requires CLI exit 1 and empty stdout. The final GET checks that the stored dashboard survived the restart and denied write. `PASS` also requires verified removal of the test container and its anonymous volumes. The image stays cached for replay.
