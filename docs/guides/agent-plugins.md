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

## Validation checklist

- [x] Root `plugin.json` declares the canonical Agent Plugins v1 schema URI.
- [x] Manifest name follows the lowercase portable naming rules.
- [x] Manifest contains only fields defined by Agent Plugins v1.
- [x] Skills use the fixed `skills/<name>/SKILL.md` layout.
- [x] No `mcp.json` is declared when there are no portable MCP server entries.
- [ ] Validate all skill frontmatter and filesystem path containment before
      claiming full client-level conformance.
