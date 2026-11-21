# Agent Plugins compatibility

AFK publishes a portable Agent Plugins v1 package while retaining its existing
Claude Code marketplace metadata.

## Package layout

- `plugin.json` is the portable manifest at the repository/plugin root and
  targets Agent Plugins specification `1.0.0`.
- `skills/<skill-name>/SKILL.md` is the fixed discovery location for skills.
- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` remain
  in place for Claude Code's marketplace and plugin-specific behavior.
- `mcp.json` is intentionally absent because this package currently does not
  declare portable MCP server entries. A client can still load the skills-only
  package.

## Compatibility boundaries

The root manifest uses only fields defined by Agent Plugins v1. Do not add
Claude-specific fields to it; put client-specific manifest data under a
reverse-domain key in `extensions` and client-specific files under the matching
top-level extension directory.

The portable manifest does not imply that every skill's Claude-specific
frontmatter feature is implemented by every Agent Plugins client. Clients
should follow the Agent Skills specification and ignore unsupported client
features according to their own documented behavior.

### Verifying the active Claude Code skill

AFK CLI 0.2.147's ordinary batch provider delegates skill resolution to
`claude`. With Claude Code 2.1.326, the source passed to `plugin marketplace
add` affected when a new session adopted `afk-to-issues`. Both tests used
`afk@afk`, AFK's `./` plugin source, and its historical 1.2.1 and 1.2.2 skill
files. One registered a local directory. The other used the Git clone flow
against a local repository. Each session's outgoing model request contained
the full skill body of the edition shown.

| Operation | `plugin list` | Skill in listed cache | Session (Git clone) | Session (local directory) |
| --- | --- | --- | --- | --- |
| Install 1.2.1 | 1.2.1 | 1.2.1 | 1.2.1 | 1.2.1 |
| Refresh marketplace to 1.2.2 | 1.2.1 | 1.2.1 | 1.2.1 | 1.2.2 |
| Explicitly update plugin | 1.2.2 | 1.2.2 | 1.2.2 | 1.2.2 |
| Restore 1.2.1 marketplace and reinstall | 1.2.1 | 1.2.1 | 1.2.1 | 1.2.1 |

To qualify a validated skill after a catalog change, record the expected
revision and file digest, the digest at the listed install path, and the body
observed by a fresh session. The restricted analysis profile disables skills.

## Validation checklist

- [x] Root `plugin.json` declares the canonical Agent Plugins v1 schema URI.
- [x] Manifest name follows the lowercase portable naming rules.
- [x] Manifest contains only fields defined by Agent Plugins v1.
- [x] Skills use the fixed `skills/<name>/SKILL.md` layout.
- [x] No `mcp.json` is declared when there are no portable MCP server entries.
- [ ] Validate all skill frontmatter and filesystem path containment before
      claiming full client-level conformance.
