PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 3000;

BEGIN IMMEDIATE;

CREATE TABLE inventory_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  namespace_key TEXT NOT NULL CHECK (length(namespace_key) = 64),
  namespace_kind TEXT NOT NULL CHECK (namespace_kind IN ('authenticated', 'legacy_unverified')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;

CREATE TABLE sync_scopes (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('github', 'gitlab')),
  host_key TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('catalog', 'issues')),
  project_key TEXT NOT NULL DEFAULT '',
  attempt_seq INTEGER NOT NULL DEFAULT 0 CHECK (attempt_seq >= 0),
  published_seq INTEGER NOT NULL DEFAULT 0 CHECK (published_seq >= 0 AND published_seq <= attempt_seq),
  last_attempt_at_ms INTEGER,
  last_success_at_ms INTEGER,
  last_status TEXT NOT NULL DEFAULT 'never'
    CHECK (last_status IN ('never', 'running', 'success', 'partial', 'failed', 'interrupted')),
  CHECK ((scope_kind = 'catalog' AND project_key = '') OR (scope_kind = 'issues' AND project_key <> '')),
  UNIQUE (platform, host_key, scope_kind, project_key)
) STRICT;

CREATE TABLE repositories (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('github', 'gitlab')),
  project_key TEXT NOT NULL,
  host_key TEXT NOT NULL,
  provider_host TEXT,
  provider_project_id TEXT,
  name TEXT NOT NULL,
  default_branch TEXT,
  web_url TEXT,
  catalog_scope_id INTEGER NOT NULL REFERENCES sync_scopes(id) ON DELETE RESTRICT,
  catalog_listed INTEGER NOT NULL DEFAULT 0 CHECK (catalog_listed IN (0, 1)),
  last_listed_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_listed_seq >= 0),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
  UNIQUE (platform, project_key)
) STRICT;

CREATE TABLE work_items (
  row_id INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE CHECK (length(id) BETWEEN 1 AND 160),
  owner_repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
  issue_number INTEGER NOT NULL CHECK (issue_number BETWEEN 1 AND 9007199254740991),
  origin_scope_id INTEGER NOT NULL REFERENCES sync_scopes(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(title) > 0),
  description TEXT,
  managed INTEGER NOT NULL CHECK (managed IN (0, 1)),
  execution_eligible INTEGER NOT NULL CHECK (execution_eligible IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('ready', 'rework', 'in_progress', 'verification', 'merge_ready', 'done', 'blocked')),
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('afk', 'hitl')),
  parent_id TEXT,
  branch_name TEXT NOT NULL,
  provider_ref TEXT NOT NULL,
  web_url TEXT,
  owner TEXT,
  priority TEXT CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  provider_updated_at TEXT,
  sort_updated_at TEXT GENERATED ALWAYS AS (coalesce(provider_updated_at, '')) STORED,
  sources_present INTEGER NOT NULL DEFAULT 0 CHECK (sources_present IN (0, 1)),
  repositories_present INTEGER NOT NULL DEFAULT 0 CHECK (repositories_present IN (0, 1)),
  execution_plan_present INTEGER NOT NULL DEFAULT 0 CHECK (execution_plan_present IN (0, 1)),
  runs_present INTEGER NOT NULL DEFAULT 0 CHECK (runs_present IN (0, 1)),
  is_present INTEGER NOT NULL DEFAULT 1 CHECK (is_present IN (0, 1)),
  last_seen_seq INTEGER NOT NULL CHECK (last_seen_seq >= 0),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
  CHECK (execution_eligible <= managed)
) STRICT;

CREATE TABLE work_item_sources (
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  source_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('github_issue', 'gitlab_issue', 'external', 'local')),
  title TEXT NOT NULL,
  reference TEXT NOT NULL,
  role TEXT,
  platform TEXT CHECK (platform IN ('github', 'gitlab')),
  project_key TEXT,
  issue_number INTEGER CHECK (issue_number BETWEEN 1 AND 9007199254740991),
  web_url TEXT,
  PRIMARY KEY (work_item_id, position)
) STRICT;

CREATE TABLE work_item_repositories (
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
  association_id TEXT,
  role TEXT,
  checkout_path TEXT,
  base_branch TEXT NOT NULL,
  PRIMARY KEY (work_item_id, position)
) STRICT;

CREATE TABLE work_item_dependencies (
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  depends_on_id TEXT NOT NULL,
  PRIMARY KEY (work_item_id, position)
) STRICT;

CREATE TABLE work_item_tags (
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  tag TEXT NOT NULL,
  PRIMARY KEY (work_item_id, position)
) STRICT;

CREATE TABLE work_item_steps (
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  step_id TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  status TEXT CHECK (status IN ('pending', 'running', 'completed', 'blocked')),
  PRIMARY KEY (work_item_id, position)
) STRICT;

CREATE TABLE work_item_run_receipts (
  row_id INTEGER PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'completed', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  workflow TEXT,
  working_branch TEXT,
  workspace_path TEXT,
  pid INTEGER CHECK (pid BETWEEN 1 AND 9007199254740991),
  error TEXT,
  repositories_present INTEGER NOT NULL DEFAULT 0 CHECK (repositories_present IN (0, 1)),
  projection_source TEXT NOT NULL CHECK (projection_source IN ('inventory', 'workspace')),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
  UNIQUE (work_item_id, run_id)
) STRICT;

CREATE TABLE work_item_run_repositories (
  run_receipt_row_id INTEGER NOT NULL REFERENCES work_item_run_receipts(row_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  platform TEXT NOT NULL CHECK (platform IN ('github', 'gitlab')),
  project_key TEXT NOT NULL,
  provider_host TEXT,
  provider_project_id TEXT,
  name TEXT NOT NULL,
  checkout_path TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  role TEXT,
  PRIMARY KEY (run_receipt_row_id, position)
) STRICT;

CREATE TABLE sync_diagnostics (
  id INTEGER PRIMARY KEY,
  sync_scope_id INTEGER NOT NULL REFERENCES sync_scopes(id) ON DELETE CASCADE,
  attempt_seq INTEGER NOT NULL CHECK (attempt_seq > 0),
  platform TEXT NOT NULL CHECK (platform IN ('github', 'gitlab')),
  project_key TEXT,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  retryable INTEGER NOT NULL CHECK (retryable IN (0, 1)),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0)
) STRICT;

CREATE TABLE legacy_imports (
  source_key TEXT PRIMARY KEY,
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
  imported_at_ms INTEGER NOT NULL CHECK (imported_at_ms >= 0),
  status TEXT NOT NULL CHECK (status IN ('completed', 'rejected')),
  imported_items INTEGER NOT NULL CHECK (imported_items >= 0),
  rejected_entries INTEGER NOT NULL CHECK (rejected_entries >= 0)
) STRICT;

CREATE VIRTUAL TABLE work_item_search USING fts5(
  search_text,
  tokenize = 'trigram'
);

CREATE VIRTUAL TABLE repository_search USING fts5(
  search_text,
  tokenize = 'trigram'
);

CREATE INDEX idx_repositories_catalog
  ON repositories(catalog_scope_id, catalog_listed, platform, project_key);
CREATE INDEX idx_repositories_list
  ON repositories(catalog_listed, platform, project_key);
CREATE INDEX idx_repositories_provider_id
  ON repositories(platform, host_key, provider_project_id);
CREATE INDEX idx_items_recent
  ON work_items(is_present, sort_updated_at DESC, id ASC);
CREATE INDEX idx_items_state_recent
  ON work_items(is_present, state, sort_updated_at DESC, id ASC);
CREATE INDEX idx_items_project_recent
  ON work_items(owner_repository_id, is_present, sort_updated_at DESC, id ASC);
CREATE INDEX idx_items_mode_recent
  ON work_items(is_present, execution_mode, sort_updated_at DESC, id ASC);
CREATE INDEX idx_items_parent ON work_items(parent_id);
CREATE INDEX idx_items_scope_seen ON work_items(origin_scope_id, last_seen_seq);
CREATE INDEX idx_sources_project
  ON work_item_sources(platform, project_key, work_item_id);
CREATE INDEX idx_associated_repository
  ON work_item_repositories(repository_id, work_item_id);
CREATE INDEX idx_dependencies_target
  ON work_item_dependencies(depends_on_id, work_item_id);
CREATE INDEX idx_tags_lookup ON work_item_tags(tag, work_item_id);
CREATE INDEX idx_run_receipts_recent
  ON work_item_run_receipts(work_item_id, started_at DESC, run_id ASC);
CREATE INDEX idx_diagnostics_scope_attempt
  ON sync_diagnostics(sync_scope_id, attempt_seq);

CREATE TRIGGER work_items_search_delete AFTER DELETE ON work_items BEGIN
  DELETE FROM work_item_search WHERE rowid = old.row_id;
END;

CREATE TRIGGER repositories_search_delete AFTER DELETE ON repositories BEGIN
  DELETE FROM repository_search WHERE rowid = old.id;
END;

PRAGMA user_version = 1;

COMMIT;
