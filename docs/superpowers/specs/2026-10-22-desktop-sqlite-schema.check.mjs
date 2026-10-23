import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const inventory = new DatabaseSync(':memory:');
const config = new DatabaseSync(':memory:');
const workItemId = 'github:acme/api#1';

try {
  inventory.exec(readFileSync(new URL('./2026-10-22-desktop-sqlite-schema.sql', import.meta.url), 'utf8'));
  config.exec(readFileSync(new URL('./2026-10-22-desktop-local-config-schema.sql', import.meta.url), 'utf8'));

  for (const [database, tableCount] of [[inventory, 13], [config, 4]]) {
    assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(database.prepare('SELECT count(*) AS total FROM pragma_table_list WHERE strict = 1').get().total, tableCount);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  }
  assert.equal(inventory.prepare('PRAGMA synchronous').get().synchronous, 1);
  assert.equal(config.prepare('PRAGMA synchronous').get().synchronous, 2);

  inventory.exec(`
    INSERT INTO inventory_meta VALUES (1, '${'a'.repeat(64)}', 'authenticated', 0, 1);
    INSERT INTO sync_scopes(id, platform, host_key, scope_kind, project_key)
      VALUES (1, 'github', 'github.com', 'catalog', ''), (2, 'github', 'github.com', 'issues', 'acme/api');
    INSERT INTO repositories(id, platform, project_key, host_key, name, catalog_scope_id, observed_at_ms)
      VALUES (1, 'github', 'acme/api', 'github.com', 'api', 1, 1);
  `);
  inventory.prepare(`
    INSERT INTO work_items(id, owner_repository_id, issue_number, origin_scope_id, title,
      managed, execution_eligible, state, execution_mode, parent_id, branch_name, provider_ref,
      sources_present, repositories_present, last_seen_seq, observed_at_ms)
    VALUES (?, 1, 1, 2, ?, 1, 1, 'ready', 'afk', ?, 'feature/test', '#1', 1, 1, 1, 1)
  `).run(workItemId, '仓库任务 "P0":_100%', 'github:acme/other#99');
  inventory.prepare('INSERT INTO work_item_dependencies VALUES (?, 0, ?)').run(workItemId, 'github:acme/other#98');
  inventory.prepare(`INSERT INTO work_item_sources(work_item_id, position, source_id, source_type, title, reference)
    VALUES (?, 0, 'source-original', 'external', 'source', 'external-reference')`).run(workItemId);
  inventory.prepare(`INSERT INTO work_item_repositories(work_item_id, position, repository_id, association_id, base_branch)
    VALUES (?, 0, 1, 'association-original', 'main')`).run(workItemId);
  assert.equal(inventory.prepare('SELECT id FROM work_items').get().id, workItemId);
  assert.equal(inventory.prepare('SELECT association_id FROM work_item_repositories').get().association_id, 'association-original');
  assert.equal(inventory.prepare('SELECT depends_on_id FROM work_item_dependencies').get().depends_on_id, 'github:acme/other#98');
  assert.throws(() => inventory.exec('UPDATE work_items SET owner_repository_id = 999'), /FOREIGN KEY/);
  assert.throws(() => inventory.exec('UPDATE work_items SET managed = 0'), /CHECK constraint/);
  assert.throws(() => inventory.exec('DELETE FROM repositories WHERE id = 1'), /FOREIGN KEY/);
  assert.ok(inventory.prepare(`EXPLAIN QUERY PLAN SELECT id FROM work_items
    WHERE is_present = 1 ORDER BY sort_updated_at DESC, id ASC LIMIT 51`).all()
    .some(operation => operation.detail.includes('idx_items_recent')));

  inventory.prepare(`INSERT INTO work_item_run_receipts(work_item_id, run_id, status, started_at, projection_source, observed_at_ms)
    VALUES (?, 'attempt-1', 'starting', '2026-10-22T00:00:00.000Z', 'workspace', 1)`).run(workItemId);
  const receiptId = inventory.prepare('SELECT row_id FROM work_item_run_receipts').get().row_id;
  inventory.prepare(`INSERT INTO work_item_run_repositories(run_receipt_row_id, position, platform, project_key, name, checkout_path, base_branch)
    VALUES (?, 0, 'github', 'acme/api', 'api', 'api', 'main')`).run(receiptId);
  assert.equal(inventory.prepare('SELECT run_id FROM work_item_run_receipts').get().run_id, 'attempt-1');

  const itemRowId = inventory.prepare('SELECT row_id FROM work_items').get().row_id;
  inventory.prepare('INSERT INTO work_item_search(rowid, search_text) VALUES (?, ?)').run(itemRowId, '仓库任务 "P0":_100%');
  inventory.exec("INSERT INTO repository_search(rowid, search_text) VALUES (1, 'acme/api 仓库检索')");
  for (const query of ['仓库任', '"P0"', ':_100%']) {
    const literal = `"${query.replaceAll('"', '""')}"`;
    assert.equal(inventory.prepare('SELECT rowid FROM work_item_search WHERE work_item_search MATCH ?').get(literal).rowid, itemRowId);
  }
  assert.equal(inventory.prepare("SELECT instr(title, '任务') AS position FROM work_items").get().position, 3);
  inventory.exec('BEGIN; UPDATE work_items SET title = \'changed\'; UPDATE inventory_meta SET revision = 1; ROLLBACK;');
  assert.equal(inventory.prepare('SELECT title FROM work_items').get().title, '仓库任务 "P0":_100%');
  assert.equal(inventory.prepare('SELECT revision FROM inventory_meta').get().revision, 0);

  config.exec(`
    INSERT INTO local_config_meta VALUES (1, 0, 1);
    INSERT INTO ssh_bastions(id, alias, hostname, port, username, jms_server_alias, linux_only, created_at_ms, updated_at_ms)
      VALUES ('managed:bastion-original', 'gateway', 'gateway.invalid', 22, 'operator', 'jms-gateway', 1, 1, 1);
  `);
  const insertHost = ({ id, alias = id, port = 22, type = null, reference = null, bastionId = null }) => config.prepare(`
    INSERT INTO ssh_managed_hosts(id, alias, hostname, port, jump_host_type, jump_host_reference, bastion_id, created_at_ms, updated_at_ms)
    VALUES (?, ?, 'target.invalid', ?, ?, ?, ?, 1, 1)
  `).run(id, alias, port, type, reference, bastionId);

  insertHost({ id: 'managed:host-original', alias: 'direct' });
  insertHost({ id: 'managed:openssh', type: 'openssh', reference: 'gateway' });
  insertHost({ id: 'managed:unresolved', type: 'jumpserver', reference: 'unavailable' });
  insertHost({ id: 'managed:asset', type: 'jumpserver', reference: 'gateway', bastionId: 'managed:bastion-original' });
  insertHost({ id: 'managed:legacy-asset', type: 'jumpserver', reference: 'gateway' });
  for (const invalid of [
    { id: 'system:invalid' },
    { id: 'managed:duplicate', alias: 'direct' },
    { id: 'managed:port-zero', port: 0 },
    { id: 'managed:port-large', port: 65536 },
    { id: 'managed:null-reference', reference: 'gateway' },
    { id: 'managed:null-bastion', bastionId: 'managed:bastion-original' },
    { id: 'managed:missing-reference', type: 'openssh' },
    { id: 'managed:empty-reference', type: 'jumpserver', reference: '' },
    { id: 'managed:wrong-kind', type: 'none' },
    { id: 'managed:openssh-fk', type: 'openssh', reference: 'gateway', bastionId: 'managed:bastion-original' },
    { id: 'managed:missing-bastion', type: 'jumpserver', reference: 'missing', bastionId: 'managed:missing' },
  ]) {
    assert.throws(() => insertHost(invalid), /constraint|FOREIGN KEY/i);
  }
  assert.throws(() => config.exec("UPDATE ssh_bastions SET alias = ''"), /CHECK constraint/);
  assert.throws(() => config.exec('UPDATE ssh_bastions SET port = 0'), /CHECK constraint/);
  assert.throws(() => config.exec('UPDATE ssh_managed_hosts SET updated_at_ms = 0'), /CHECK constraint/);
  assert.throws(() => config.exec("DELETE FROM ssh_bastions WHERE id = 'managed:bastion-original'"), /FOREIGN KEY/);
  config.exec("UPDATE ssh_managed_hosts SET alias = 'renamed', updated_at_ms = 2 WHERE id = 'managed:host-original'");
  assert.equal(config.prepare("SELECT id FROM ssh_managed_hosts WHERE alias = 'renamed'").get().id, 'managed:host-original');
  config.exec("UPDATE ssh_bastions SET linux_only = 0, updated_at_ms = 2 WHERE id = 'managed:bastion-original'");
  assert.equal(config.prepare('SELECT id FROM ssh_bastions').get().id, 'managed:bastion-original');

  config.exec('BEGIN');
  insertHost({ id: 'managed:rollback' });
  config.prepare('INSERT INTO local_config_imports VALUES (?, ?, 1, 1, 1, 0)').run('synthetic-import', 'b'.repeat(64));
  config.exec('UPDATE local_config_meta SET revision = 1; ROLLBACK;');
  assert.equal(config.prepare("SELECT count(*) AS total FROM ssh_managed_hosts WHERE id = 'managed:rollback'").get().total, 0);
  assert.equal(config.prepare('SELECT count(*) AS total FROM local_config_imports').get().total, 0);
  assert.equal(config.prepare('SELECT revision FROM local_config_meta').get().revision, 0);

  config.exec('BEGIN');
  config.prepare(`DELETE FROM ssh_managed_hosts WHERE jump_host_type = 'jumpserver'
    AND (bastion_id = ? OR (bastion_id IS NULL AND jump_host_reference = ?))`).run('managed:bastion-original', 'gateway');
  config.exec("DELETE FROM ssh_bastions WHERE id = 'managed:bastion-original'; UPDATE local_config_meta SET revision = 1; COMMIT;");
  assert.deepEqual(config.prepare('SELECT id FROM ssh_managed_hosts ORDER BY id').all().map(host => host.id), [
    'managed:host-original', 'managed:openssh', 'managed:unresolved',
  ]);

  const retainedHosts = config.prepare('SELECT * FROM ssh_managed_hosts ORDER BY id').all();
  inventory.exec('BEGIN; DELETE FROM work_items; DELETE FROM repositories; DELETE FROM sync_scopes; COMMIT;');
  assert.deepEqual(config.prepare('SELECT * FROM ssh_managed_hosts ORDER BY id').all(), retainedHosts);
  assert.equal(config.prepare('SELECT revision FROM local_config_meta').get().revision, 1);
  for (const table of ['work_item_sources', 'work_item_dependencies', 'work_item_repositories', 'work_item_run_receipts', 'work_item_run_repositories', 'work_item_search', 'repository_search']) {
    assert.equal(inventory.prepare(`SELECT count(*) AS total FROM ${table}`).get().total, 0);
  }
  for (const table of ['ssh_managed_hosts', 'ssh_bastions']) {
    assert.ok(config.prepare(`PRAGMA table_info('${table}')`).all().every(column => !/password|secret|token|otp|private_key/i.test(column.name)));
  }
  for (const database of [inventory, config]) {
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  }
  console.log(`SQLite schemas OK: Node ${process.versions.node}, SQLite ${inventory.prepare('SELECT sqlite_version() AS version').get().version}; inventory 13 + 2 FTS, config 4.`);
} finally {
  inventory.close();
  config.close();
}
