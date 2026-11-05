# ADR-0029: JumpServer assets are opened through the jms CLI

- Status: accepted
- Date: 2026-11-05

## Context

The desktop client modelled a JumpServer bastion as an OpenSSH hop: a managed
host with `jumpHostType: jumpserver` resolved its `jumpHost` alias through
`ssh -G` and connected with `ssh -J <alias>`. Uploads used `scp -J`, status used
`ssh-keyscan` plus `BatchMode=yes`, and the first connection demanded a trusted
host fingerprint.

That model never matched how a JumpServer is reached. Its SSH port is Koko, not
sshd: the endpoint authenticates with a password and often an OTP, and it does
not accept an OpenSSH client hop at all. Measured against
`dev-jumpserver.fangcloud.net:2222`, the agreement's own bastion:

```
$ ssh -J wangwendi@dev-jumpserver.fangcloud.net:2222 -l root -- 172.16.206.239 true
wangwendi@dev-jumpserver.fangcloud.net: Permission denied (password,publickey).
```

The asset itself is also unreachable directly — internal `172.16.x` addresses
time out from the laptop — and it has no host key AFK could pin, because the
bastion terminates the session. So the `-J` path could not authenticate, could
not scan a fingerprint, and could not connect, no matter how the alias was
configured.

At the same time the bastion already ships a working client. `jms` logs in with
its stored access key and exposes exactly the surfaces AFK needs:

```
$ jms exec llm-wiki@dev 'hostname; whoami'
llm-wiki
root
$ jms login llm-wiki@dev      # interactive shell
$ jms sftp ./report.pdf llm-wiki@dev:/srv/report.pdf
$ jms ls dev                  # asset inventory the bastion sync already uses
```

The bastion sync (`jumpserver-service`) already shelled out to that same binary
to add servers and list assets; only the connection path ignored it.

## Decision

A host with `jumpHostType: jumpserver` is connected **only** through `jms`, and
AFK no longer builds an OpenSSH hop for it:

| Operation | Command |
| --- | --- |
| Connect (PTY) | `jms login <asset>@<server>` |
| Status / test | `jms exec <asset>@<server> true` |
| Upload | `jms sftp <local> <asset>@<server>:<dir>` |
| External terminal | the same `jms login` command, quoted |

`jms` resolves the target from its own configuration, so AFK does not need a
working `~/.ssh/config` alias for the bastion. A new
`jms-connection-service` maps an AFK host onto the `<asset>@<server>` pair:

1. Server alias: the AFK bastion record's `jmsServerAlias`, then the `jumpHost`
   alias itself when it matches a configured jms server, then the bastion
   hostname matched against each server's stored URL, then — with exactly one
   server configured — that server.
2. Asset: the JumpServer asset whose name equals the AFK alias, falling back to
   the asset whose address equals the AFK hostname. The inventory is cached per
   server for a minute so browsing a list does not log in once per row.

Because the bastion owns authentication and host verification, JumpServer hosts
carry no `fingerprint`, never enter `known_hosts`, reject `ssh.trust`, and never
store a local password. Their status derives from `jms exec` alone, and the
details pane reports the connection mode as `jms · <bastion>` instead of a
ProxyJump.

## Consequences

- JumpServer assets become reachable from the desktop client for the first
  time; the connect, test, upload and external-terminal buttons all use one
  transport instead of four that silently failed.
- `jms` becomes a hard runtime dependency for JumpServer hosts, not only for
  bastion sync. When the binary is missing, connecting fails with the install
  instruction instead of a misleading SSH error.
- AFK no longer needs, and no longer creates, an OpenSSH alias for a
  JumpServer bastion. A `Host` entry may still exist for unrelated reasons; it
  is ignored on this path.
- Each operation pays one `jms` login. That is visible as a one-to-two second
  first connection and is bounded by the existing ten-second host-status cache.
- OpenSSH ProxyJump stays available and unchanged for `jumpHostType: openssh`,
  which is a genuine `ssh -J` hop.
