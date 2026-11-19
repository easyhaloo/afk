# AFK mounted Git workspace service

Serve `repository.remote-workspace` with Apache 2.4 CGI, Python 3.9+, SQLite and Git. One service configuration serves one allowlisted repository. AFK drives prepare, checkout, the configured action, publish and cleanup through its existing managed provider. The server uses Git linked worktrees and pushes the verified commit to a branch. The base branch is protected.

## Install

Use a dedicated POSIX service account and a trusted AFK executor. Both need the **same canonical absolute paths** to the workspace root and Git common directory. The CGI account needs read access to AFK's repository claims and write access to its Git common directory and workspace root. The reference installation runs both as one dedicated user. Store the common directory on a filesystem with SQLite locking, `flock` and stable inode identities. Keep the server configuration, bearer file, claims, and Git administration files outside the editable checkout. Every token holder and writer to those administration files is in the same trust domain. AFK's wire request carries the run ID and session handle. The service binds the session to the generation observed in the shared claim store.

1. Prepare a private directory such as `/srv/afk-parcel`, an empty `mount` subdirectory and a Git clone under `store`. Configure the clone's single `origin` fetch and push URLs to match `remoteUrl`. The service launches Git with HTTPS/HTTP transports, disabled hooks, no prompt, and no system or user Git configuration. Configure any required upstream Git access on the dedicated server side. The workspace bearer authenticates only the workspace API.
2. Install the CGI under a dedicated executable directory. Generate the bearer file as the service account and provision the matching secret to AFK through its credential mechanism.

   ```sh
   install -m 0755 services/mounted-workspace/workspace.py /srv/afk-parcel/cgi/workspace
   (umask 077 && openssl rand -hex 32 > /srv/afk-parcel/token)
   ```

3. Save the following operator-owned configuration outside the web root. `claimsRoot` points at the `claims/repositories` directory under the client's effective AFK state root. Pre-create that directory for a new installation. `branchPrefix` allows run branches under the specified namespace, with `afk/` as the default.

   ```json
   {
     "name": "parcel", "baseBranch": "main", "branchPrefix": "afk/",
     "gitDirectory": "/srv/afk-parcel/store/.git",
     "remoteUrl": "https://git.example.invalid/team/parcel.git",
     "workspaceRoot": "/srv/afk-parcel/mount",
     "leaseKey": "gitlab:git.example.invalid/team/parcel",
     "claimsRoot": "/srv/afk-state/claims/repositories",
     "tokenFile": "/srv/afk-parcel/token"
   }
   ```

4. In a TLS virtual host, enable `mod_ssl`, `mod_alias`, `mod_env` and CGI support. Use a certificate trusted by the AFK process. Mount the script outside `DocumentRoot`.

   ```apache
   SSLOptions +StdEnvVars
   ScriptAlias /workspaces /srv/afk-parcel/cgi/workspace
   SetEnv AFK_WORKSPACE_CONFIG /srv/afk-parcel/service.json
   <Directory /srv/afk-parcel/cgi>
       CGIPassAuth On
       LimitRequestBody 8192
       Require all granted
   </Directory>
   ```

5. Run `afk plugin configure repository.remote-workspace --builtin --file client.json` with this client configuration and the matching bearer supplied as `AFK_MOUNT_TOKEN` to AFK. Use the repository provider's `run` operation or select `remote-workspace` for a managed workflow.

   ```json
   {
     "baseUrl": "https://workspace.example.invalid", "token": {"env": "AFK_MOUNT_TOKEN"},
     "managed": {"workspaceRoot": "/srv/afk-parcel/mount", "repositories": [{
       "name": "parcel", "gitDirectory": "/srv/afk-parcel/store/.git",
       "remoteUrl": "https://git.example.invalid/team/parcel.git", "leaseKey": "gitlab:git.example.invalid/team/parcel"
     }]},
     "lifecycle": {"repositories": [{"url": "parcel", "ref": "main"}],
                   "operations": ["prepare", "checkout", "publish", "cleanup"]}
   }
   ```

## Recover an interrupted session

Use the installed script locally as the service account. `inspect` reads the journal in the configured Git common directory. `recover` requires the exact session ID, an absent client claim, the registered mount and the last safe revision. It refuses a live claim, dirty files, hidden index entries, and unpublished commits. Resolve any AFK claim through the owning executor's normal lifecycle. Preserve any changed files or commits before reconciling the checkout. A crash between a Git mutation and its journal update can leave an ambiguous registration or branch. The service retains it for operator inspection.

```sh
/srv/afk-parcel/cgi/workspace /srv/afk-parcel/service.json inspect
/srv/afk-parcel/cgi/workspace /srv/afk-parcel/service.json recover SESSION_ID
```

After recovery, retry the AFK run. Git reuses an existing branch only if its tip equals the selected source. A successful cleanup retains Git branch refs and removes the allocated worktree and session. If a publish response was lost, inspect the remote ref to determine whether the push took effect.

## Replay the installed acceptance

```sh
python3 tests/qualification/w10/mounted-workspace.py /absolute/path/to/installed/afk
```

Pass an installed AFK directory or executable. The script needs Node on `PATH`, Git with `git-http-backend`, OpenSSL, and Apache with prefork, CGI and TLS modules. `--httpd` and `--modules` select a local Apache installation. It runs unprivileged, installs the same service file into a temporary CGI directory, and binds both workspace HTTPS and Git Smart HTTP to loopback. A separate HTTP action pauses the installed run after checkout so the test can stop Apache before publication. The test restarts Apache, checks the durable lease, exercises recovery refusals, retries the same run and reads the published file and branch SHAs directly from a bare repository. Standard output is the JSON receipt. This exercises one host, one shared filesystem and an explicit capability invocation. Cross-host filesystem behavior and tracker-driven work items require separate acceptance.
