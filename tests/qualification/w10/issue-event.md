# W10 signed issue events

On November 19, 2026, installed AFK CLI 0.2.147 consumed three signed webhooks directly from a temporary standalone Gitea 28.4.0 service on macOS arm64. The local CLI archive SHA-256 was `fa62beb4ea2d97f75c406d3e5dbf6beac602d777c396402135c4e35c83f5c7e9`, built from `7dc7990d687b828a73e7d3f6eb2e8c7859cd3614`. The W10 matrix originally classified `trigger.issue-event` as `fixture`. Installed cases N017–N020 used simulated host transports and N025 covered failure paths. This run supplies service-level evidence for the issue producer, project identity, action filtering and single consumption.

The harness created and closed issue #1 with label `ready` in the private loopback repository `qualifier/parcel`. Gitea also emitted `label_updated` when it attached the label. The harness verified the original body and SHA-256 HMAC in Gitea’s delivery history, checked the repository ID, full name, issue number and label, then matched each HTTP 202 response to a distinct AFK queue receipt. AFK rejected all three modified bodies with HTTP 401. Each byte-identical replay returned its original AFK delivery ID and `duplicate=true`. All three queue records finished in one attempt. Only `opened` matched the configured action and label, and the verifier wrote one line. The JSON receipt retains source UUIDs, body digests, AFK delivery IDs, attempts and the action count.

On November 20, 2026, CLI 0.2.162 consumed the same three event types from Gitea 28.4.0. After all deliveries settled, the harness stopped the AFK listener and started a fresh process on the same address using the same SQLite queue. After restart each original signed body returned the same delivery ID and each modified body received HTTP 401. The queue retained three delivered entries with one attempt each, and the action file contained one line. See [restart receipt](issue-event-restart.receipt.json). The harness initiated these replays.

Gitea's webhook history form also resends a selected event. Replaying `opened` this way generated a new source UUID for the original signed body. CLI 0.2.162 accepted a second queue entry. With CLI 0.2.163, the same operation after listener restart returned the first delivery ID with `duplicate=true`. The queue retained three delivered entries and the action ran once. This check covers byte-identical Gitea issue openings during queue retention. See the [provider replay receipt](issue-event-upstream.receipt.json).

## Reproduce

Run from this directory with ordinary Python 3, Git and Node on PATH. Supply the installed release launcher and extracted Gitea binary. The script creates its own profiles and database, binds both services to loopback, and stops them on exit. Raw hook history and credentials are deleted with the temporary directory.

```sh
python3 issue-event.py \
  /path/to/installed/afk \
  /path/to/gitea > /tmp/w10-issue-rerun.json
```

The Gitea binary came from `brew fetch gitea` followed by `tar -xzf "$(brew --cache gitea)"` in a private directory. Its server CLI supplied migration and user setup. The harness uses Gitea’s local REST API for repository, label, webhook and issue operations. It reads the local SQLite delivery history and submits the replay form as the temporary repository owner.
