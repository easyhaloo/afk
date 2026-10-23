export const localConfigSchema = `
CREATE TABLE local_config_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;

CREATE TABLE ssh_bastions (
  id TEXT PRIMARY KEY CHECK (substr(id, 1, 8) = 'managed:' AND length(id) > 8),
  alias TEXT NOT NULL UNIQUE CHECK (length(alias) > 0),
  hostname TEXT NOT NULL CHECK (length(hostname) > 0),
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  username TEXT NOT NULL CHECK (length(username) > 0),
  jms_server_alias TEXT NOT NULL CHECK (length(jms_server_alias) > 0),
  linux_only INTEGER NOT NULL CHECK (linux_only IN (0, 1)),
  last_synced_at TEXT,
  last_sync_asset_count INTEGER CHECK (last_sync_asset_count >= 0),
  last_sync_skipped_count INTEGER CHECK (last_sync_skipped_count >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
) STRICT;

CREATE TABLE ssh_managed_hosts (
  id TEXT PRIMARY KEY CHECK (substr(id, 1, 8) = 'managed:' AND length(id) > 8),
  alias TEXT NOT NULL UNIQUE CHECK (length(alias) > 0),
  hostname TEXT NOT NULL CHECK (length(hostname) > 0),
  port INTEGER NOT NULL DEFAULT 22 CHECK (port BETWEEN 1 AND 65535),
  username TEXT,
  identity_file TEXT,
  remote_workspace TEXT,
  legacy_proxy_jump TEXT,
  jump_host_type TEXT CHECK (jump_host_type IN ('openssh', 'jumpserver')),
  jump_host_reference TEXT,
  bastion_id TEXT REFERENCES ssh_bastions(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (
    CASE
      WHEN jump_host_type IS NULL THEN jump_host_reference IS NULL AND bastion_id IS NULL
      WHEN jump_host_type = 'openssh' THEN jump_host_reference IS NOT NULL AND length(jump_host_reference) > 0 AND bastion_id IS NULL
      WHEN jump_host_type = 'jumpserver' THEN jump_host_reference IS NOT NULL AND length(jump_host_reference) > 0
      ELSE 0
    END
  )
) STRICT;

CREATE TABLE local_config_imports (
  source_key TEXT PRIMARY KEY,
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
  imported_at_ms INTEGER NOT NULL CHECK (imported_at_ms >= 0),
  imported_hosts INTEGER NOT NULL CHECK (imported_hosts >= 0),
  imported_bastions INTEGER NOT NULL CHECK (imported_bastions >= 0),
  diagnostic_count INTEGER NOT NULL CHECK (diagnostic_count >= 0)
) STRICT;

CREATE INDEX idx_ssh_hosts_target ON ssh_managed_hosts(hostname, port, username);
CREATE INDEX idx_ssh_hosts_bastion ON ssh_managed_hosts(bastion_id);
CREATE INDEX idx_ssh_hosts_jump_reference ON ssh_managed_hosts(jump_host_type, jump_host_reference);
`;
