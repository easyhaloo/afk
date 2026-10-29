import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type {
  InventoryDiagnostic,
  InventoryItem,
  InventoryPage,
  InventoryProject,
  InventoryQuery,
  InventoryScope,
  InventorySnapshot,
  InventorySource,
  InventoryRepository,
  InventoryRun,
  InventoryStep,
  LocalInventoryStore,
  InventoryAttempt,
} from '@afk/application';
import { inventoryNamespace, localStoragePaths } from './paths.js';
import { openSqlite, transaction, type SqliteDatabase } from './sqlite.js';
import { INVENTORY_SCHEMA } from './inventory-schema.js';

type Row = { [column: string]: unknown };
type StoreOptions = { root?: string; namespaceKey?: string; databasePath?: string; database?: SqliteDatabase };

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;

export class SqliteInventoryStore implements LocalInventoryStore {
  readonly databasePath: string;
  private readonly database: SqliteDatabase;

  constructor(options: StoreOptions = {}) {
    const namespaceKey = options.namespaceKey;
    if (!namespaceKey) throw new Error('Inventory namespace key is required');
    if (!/^[a-f\d]{64}$/.test(namespaceKey)) throw new Error('Inventory namespace key must be a SHA-256 hex string');
    this.databasePath = options.databasePath ?? join(localStoragePaths(options.root).inventory, `${namespaceKey}.sqlite`);
    this.database = options.database ?? openSqlite({ file: this.databasePath, schema: INVENTORY_SCHEMA, durability: 'NORMAL', initialize: database => {
      const current = database.prepare('SELECT namespace_key FROM inventory_meta WHERE singleton = 1').get();
      if (current && current.namespace_key !== namespaceKey) throw new Error('Inventory namespace does not match the database');
      if (!current) database.prepare('INSERT INTO inventory_meta(singleton,namespace_key,namespace_kind,created_at_ms) VALUES (1,?,\'authenticated\',?)').run(namespaceKey, Date.now());
    }});
  }

  close(): void { this.database.close(); }

  async clear(): Promise<void> {
    transaction(this.database, () => {
      this.database.prepare('DELETE FROM work_item_search').run();
      this.database.prepare('DELETE FROM repository_search').run();
      for (const table of ['work_item_run_repositories', 'work_item_run_receipts', 'work_item_sources', 'work_item_repositories', 'work_item_dependencies', 'work_item_tags', 'work_item_steps', 'work_items', 'repositories', 'sync_diagnostics', 'sync_scopes']) this.database.prepare(`DELETE FROM ${table}`).run();
      this.bumpRevision();
    });
  }

  async hasLegacyImport(sourceKey: string): Promise<boolean> {
    return Boolean(this.database.prepare('SELECT 1 FROM legacy_imports WHERE source_key = ?').get(sourceKey));
  }

  async recordLegacyImport(sourceKey: string, sourceSha256: string, importedItems: number, rejectedEntries = 0): Promise<void> {
    transaction(this.database, () => {
      this.database.prepare('INSERT OR IGNORE INTO legacy_imports(source_key,source_sha256,imported_at_ms,status,imported_items,rejected_entries) VALUES (?, ?, ?, \'success\', ?, ?)')
        .run(sourceKey, sourceSha256, Date.now(), importedItems, rejectedEntries);
    });
  }

  async begin(scope: InventoryScope): Promise<InventoryAttempt> {
    return transaction(this.database, () => {
      const id = this.scopeId(scope);
      const now = Date.now();
      const current = this.database.prepare('SELECT id,attempt_seq FROM sync_scopes WHERE id = ?').get(id);
      const sequence = Number(current?.attempt_seq ?? 0) + 1;
      if (current) {
        this.database.prepare('UPDATE sync_scopes SET attempt_seq = ?, last_attempt_at_ms = ?, last_status = \'running\' WHERE id = ?').run(sequence, now, id);
      } else {
        this.database.prepare('INSERT INTO sync_scopes(id,platform,host_key,scope_kind,project_key,attempt_seq,last_attempt_at_ms,last_status) VALUES (?,?,?,?,?,?,?,\'running\')')
          .run(id, scope.platform, scope.host, scope.kind, scope.projectKey ?? '', sequence, now);
      }
      return { scope, sequence };
    });
  }

  async publish(attempt: InventoryAttempt, snapshot: InventorySnapshot): Promise<boolean> {
    return transaction(this.database, () => {
      const id = this.scopeId(attempt.scope);
      const scope = this.database.prepare('SELECT attempt_seq FROM sync_scopes WHERE id = ?').get(id);
      if (!scope || Number(scope.attempt_seq) !== attempt.sequence) return false;
      const now = Date.now();
      const projectIds = new Set<number>();
      for (const project of snapshot.projects) projectIds.add(this.upsertProject(project, id, attempt.sequence, now));
      const itemIds = new Set<string>();
      for (const item of snapshot.items) {
        const projectId = this.upsertProject(item.project, id, attempt.sequence, now);
        this.upsertItem(item, projectId, id, attempt.sequence, now);
        itemIds.add(item.id);
      }
      if (snapshot.complete) {
        this.database.prepare('UPDATE repositories SET catalog_listed = 0 WHERE catalog_scope_id = ?').run(id);
        for (const projectId of projectIds) this.database.prepare('UPDATE repositories SET catalog_listed = 1, last_listed_seq = ? WHERE id = ?').run(attempt.sequence, projectId);
        const rows = this.database.prepare('SELECT id FROM work_items WHERE origin_scope_id = ?').all(id);
        for (const row of rows) if (!itemIds.has(String(row.id))) this.database.prepare('UPDATE work_items SET is_present = 0 WHERE id = ?').run(row.id);
      }
      const status = snapshot.complete ? 'success' : 'partial';
      this.database.prepare('UPDATE sync_scopes SET published_seq = ?, last_success_at_ms = ?, last_status = ? WHERE id = ?').run(attempt.sequence, snapshot.complete ? now : null, status, id);
      this.replaceDiagnostics(id, attempt.sequence, snapshot.diagnostics, now);
      this.bumpRevision();
      return true;
    });
  }

  async fail(attempt: InventoryAttempt, diagnostic: InventoryDiagnostic): Promise<boolean> {
    return transaction(this.database, () => {
      const id = this.scopeId(attempt.scope);
      const scope = this.database.prepare('SELECT attempt_seq FROM sync_scopes WHERE id = ?').get(id);
      if (!scope || Number(scope.attempt_seq) !== attempt.sequence) return false;
      const now = Date.now();
      this.replaceDiagnostics(id, attempt.sequence, [diagnostic], now);
      this.database.prepare('UPDATE sync_scopes SET last_status = \'failed\' WHERE id = ?').run(id);
      this.bumpRevision();
      return true;
    });
  }

  async query(input: InventoryQuery = {}): Promise<InventoryPage<InventoryItem>> {
    const page = this.readPage(input, false);
    return { ...page, items: page.items.map(row => this.readItem(String(row.id))) };
  }

  async repositories(input: Pick<InventoryQuery, 'platform' | 'text' | 'limit' | 'cursor'> = {}): Promise<InventoryPage<InventoryProject>> {
    const limit = parseLimit(input.limit);
    const revision = this.revision();
    const filter = JSON.stringify({ platform: input.platform ?? 'all', text: input.text ?? '' });
    const cursor = decodeCursor(input.cursor, revision, filter);
    const conditions = ['1 = 1'];
    const params: unknown[] = [];
    if (input.platform && input.platform !== 'all') { conditions.push('r.platform = ?'); params.push(input.platform); }
    if (input.text) { conditions.push(...this.searchCondition('repository_search', 'r.id', input.text, params)); }
    if (cursor) { conditions.push('(r.project_key > ?)'); params.push(cursor.id); }
    const rows = this.database.prepare(`SELECT r.* FROM repositories r WHERE ${conditions.join(' AND ')} ORDER BY r.project_key ASC LIMIT ${limit + 1}`).all(...params);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(row => this.projectFromRow(row));
    return { items, nextCursor: hasMore ? encodeCursor({ revision, filter, id: String(rows[limit - 1].project_key) }) : undefined, revision, lastSuccessAt: this.lastSuccessAt(), complete: this.complete(), diagnostics: this.diagnostics() };
  }

  async get(id: string): Promise<InventoryItem | undefined> {
    const row = this.database.prepare('SELECT id FROM work_items WHERE id = ?').get(id);
    return row ? this.readItem(id) : undefined;
  }

  async titles(ids: readonly string[]): Promise<Array<{ id: string; title?: string }>> {
    return ids.map(id => {
      const row = this.database.prepare('SELECT title FROM work_items WHERE id = ?').get(id);
      return row ? { id, title: String(row.title) } : { id };
    });
  }

  private readPage(input: InventoryQuery, includeHidden: boolean): InventoryPage<Row> {
    const limit = parseLimit(input.limit);
    const revision = this.revision();
    const filter = JSON.stringify({ platform: input.platform ?? 'all', state: input.state ?? '', executionMode: input.executionMode ?? '', project: input.project ?? '', tag: input.tag ?? '', text: input.text ?? '', parentId: input.parentId ?? '', hidden: includeHidden });
    const cursor = decodeCursor(input.cursor, revision, filter);
    const conditions = [includeHidden ? '1 = 1' : 'w.is_present = 1'];
    const params: unknown[] = [];
    if (input.state) { conditions.push('w.state = ?'); params.push(input.state); }
    if (input.executionMode) { conditions.push('w.execution_mode = ?'); params.push(input.executionMode); }
    if (input.project) { conditions.push('r.project_key = ?'); params.push(input.project); }
    if (input.platform && input.platform !== 'all') { conditions.push('((w.sources_present = 0 AND r.platform = ?) OR EXISTS (SELECT 1 FROM work_item_sources sx WHERE sx.work_item_id = w.id AND sx.platform = ?))'); params.push(input.platform, input.platform); }
    if (input.tag) { conditions.push('EXISTS (SELECT 1 FROM work_item_tags tx WHERE tx.work_item_id = w.id AND tx.tag = ?)'); params.push(input.tag); }
    if (input.parentId) { conditions.push('w.parent_id = ?'); params.push(input.parentId); }
    if (input.text) conditions.push(...this.searchCondition('work_item_search', 'w.row_id', input.text, params));
    if (cursor && 'time' in cursor) { conditions.push('(w.sort_updated_at < ? OR (w.sort_updated_at = ? AND w.id > ?))'); params.push(cursor.time, cursor.time, cursor.id); }
    const rows = this.database.prepare(`SELECT w.id,w.sort_updated_at FROM work_items w JOIN repositories r ON r.id = w.owner_repository_id WHERE ${conditions.join(' AND ')} ORDER BY w.sort_updated_at DESC,w.id ASC LIMIT ${limit + 1}`).all(...params);
    const hasMore = rows.length > limit;
    const visible = rows.slice(0, limit);
    const last = visible.at(-1);
    return { items: visible, nextCursor: hasMore && last ? encodeCursor({ revision, filter, time: String(last.sort_updated_at), id: String(last.id) }) : undefined, revision, lastSuccessAt: this.lastSuccessAt(), complete: this.complete(), diagnostics: this.diagnostics() };
  }

  private searchCondition(table: string, rowid: string, text: string, params: unknown[]): string[] {
    if ([...text].length < 3) { params.push(text.toLowerCase()); return [`instr(lower(${table === 'work_item_search' ? 'w.title || \' \' || coalesce(w.description, \'\')' : 'r.project_key || \' \' || r.name'}), ?) > 0`]; }
    const literal = `"${text.replaceAll('"', '""')}"`;
    if (!/^[\p{L}\p{N}]+$/u.test(text)) {
      params.push(text.toLowerCase());
      return [`instr(lower(${table === 'work_item_search' ? "w.title || ' ' || coalesce(w.description, '')" : "r.project_key || ' ' || r.name"}), ?) > 0`];
    }
    params.push(literal, text.toLowerCase());
    const textExpression = table === 'work_item_search' ? "w.title || ' ' || coalesce(w.description, '')" : "r.project_key || ' ' || r.name";
    return [`(${rowid} IN (SELECT rowid FROM ${table} WHERE ${table} MATCH ?) OR instr(lower(${textExpression}), ?) > 0)`];
  }

  private upsertProject(project: InventoryProject, scopeId: number, sequence: number, now: number): number {
    const existing = this.database.prepare('SELECT id FROM repositories WHERE platform = ? AND project_key = ?').get(project.platform, project.projectKey);
    if (existing) {
      this.database.prepare('UPDATE repositories SET host_key = ?, provider_host = ?, provider_project_id = ?, name = ?, default_branch = ?, web_url = ?, catalog_scope_id = ?, observed_at_ms = ? WHERE id = ?').run(project.providerHost ?? project.platform, project.providerHost ?? null, project.providerProjectId ?? null, project.name, project.defaultBranch ?? null, project.webUrl ?? null, scopeId, now, existing.id);
      this.database.prepare('INSERT OR REPLACE INTO repository_search(rowid,search_text) VALUES (?,?)').run(existing.id, `${project.projectKey} ${project.name}`);
      return Number(existing.id);
    }
    const result = this.database.prepare('INSERT INTO repositories(platform,project_key,host_key,provider_host,provider_project_id,name,default_branch,web_url,catalog_scope_id,catalog_listed,last_listed_seq,observed_at_ms) VALUES (?,?,?,?,?,?,?,?,?,1,?,?)').run(project.platform, project.projectKey, project.providerHost ?? project.platform, project.providerHost ?? null, project.providerProjectId ?? null, project.name, project.defaultBranch ?? null, project.webUrl ?? null, scopeId, sequence, now) as { lastInsertRowid?: number };
    const id = Number(result.lastInsertRowid);
    this.database.prepare('INSERT INTO repository_search(rowid,search_text) VALUES (?,?)').run(id, `${project.projectKey} ${project.name}`);
    return id;
  }

  private upsertItem(item: InventoryItem, repositoryId: number, scopeId: number, sequence: number, now: number): void {
    if (item.id !== `${item.project.platform}:${item.project.projectKey}#${item.issueNumber}`) throw new Error(`Inventory item identity does not match its project: ${item.id}`);
    const existing = this.database.prepare('SELECT row_id FROM work_items WHERE id = ?').get(item.id);
    const values = [repositoryId, item.issueNumber, scopeId, item.title, item.description ?? null, bool(item.managed), bool(item.executionEligible), item.state, item.executionMode, item.parentId ?? null, item.branchName, item.providerRef, item.webUrl ?? null, item.owner ?? null, item.priority ?? null, item.updatedAt ?? null, item.sources !== undefined ? 1 : 0, item.repositories !== undefined ? 1 : 0, item.executionPlan !== undefined ? 1 : 0, item.runs !== undefined ? 1 : 0, sequence, now];
    if (existing) this.database.prepare(`UPDATE work_items SET owner_repository_id=?,issue_number=?,origin_scope_id=?,title=?,description=?,managed=?,execution_eligible=?,state=?,execution_mode=?,parent_id=?,branch_name=?,provider_ref=?,web_url=?,owner=?,priority=?,provider_updated_at=?,sources_present=?,repositories_present=?,execution_plan_present=?,runs_present=?,is_present=1,last_seen_seq=?,observed_at_ms=? WHERE row_id=?`).run(...values, existing.row_id);
    else this.database.prepare(`INSERT INTO work_items(owner_repository_id,issue_number,origin_scope_id,title,description,managed,execution_eligible,state,execution_mode,parent_id,branch_name,provider_ref,web_url,owner,priority,provider_updated_at,sources_present,repositories_present,execution_plan_present,runs_present,is_present,last_seen_seq,observed_at_ms,id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`).run(...values, item.id);
    const row = this.database.prepare('SELECT row_id FROM work_items WHERE id = ?').get(item.id)!;
    const rowId = Number(row.row_id);
    for (const table of ['work_item_sources', 'work_item_repositories', 'work_item_dependencies', 'work_item_tags', 'work_item_steps'] as const) this.database.prepare(`DELETE FROM ${table} WHERE work_item_id = ?`).run(item.id);
    for (const [position, source] of (item.sources ?? []).entries()) this.database.prepare('INSERT INTO work_item_sources VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(item.id, position, source.id, source.type, source.title, source.reference, source.role ?? null, source.platform ?? null, source.projectKey ?? null, source.issueNumber ?? null, source.webUrl ?? null);
    for (const [position, repository] of (item.repositories ?? []).entries()) { const linked = this.upsertProject(repository, scopeId, sequence, now); this.database.prepare('INSERT INTO work_item_repositories VALUES (?,?,?,?,?,?,?)').run(item.id, position, linked, repository.id ?? null, repository.role ?? null, repository.checkoutPath ?? null, repository.baseBranch); }
    for (const [position, dependency] of item.dependsOn.entries()) this.database.prepare('INSERT INTO work_item_dependencies VALUES (?,?,?)').run(item.id, position, dependency);
    for (const [position, tag] of item.tags.entries()) this.database.prepare('INSERT INTO work_item_tags VALUES (?,?,?)').run(item.id, position, tag);
    for (const [position, step] of (item.executionPlan ?? []).entries()) this.database.prepare('INSERT INTO work_item_steps VALUES (?,?,?,?,?,?)').run(item.id, position, step.id, step.title, step.detail ?? null, step.status ?? null);
    for (const run of (item.runs ?? [])) this.upsertRun(item.id, run, now);
    this.database.prepare('INSERT OR REPLACE INTO work_item_search(rowid,search_text) VALUES (?,?)').run(rowId, `${item.id} ${item.title} ${item.description ?? ''} ${item.project.projectKey} ${item.tags.join(' ')}`);
  }

  private upsertRun(itemId: string, run: InventoryRun, now: number): void {
    const existing = this.database.prepare('SELECT row_id FROM work_item_run_receipts WHERE work_item_id=? AND run_id=?').get(itemId, run.id);
    const values = [itemId, run.id, run.status, run.startedAt, run.completedAt ?? null, run.workflow ?? null, run.workingBranch ?? null, run.workspacePath ?? null, run.pid ?? null, run.error ?? null, run.repositories !== undefined ? 1 : 0, 'inventory', now];
    if (existing) this.database.prepare('UPDATE work_item_run_receipts SET status=?,started_at=?,completed_at=?,workflow=?,working_branch=?,workspace_path=?,pid=?,error=?,repositories_present=?,projection_source=?,observed_at_ms=? WHERE row_id=?').run(...values.slice(2), existing.row_id);
    else this.database.prepare('INSERT INTO work_item_run_receipts(work_item_id,run_id,status,started_at,completed_at,workflow,working_branch,workspace_path,pid,error,repositories_present,projection_source,observed_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...values);
    const row = this.database.prepare('SELECT row_id FROM work_item_run_receipts WHERE work_item_id=? AND run_id=?').get(itemId, run.id)!;
    this.database.prepare('DELETE FROM work_item_run_repositories WHERE run_receipt_row_id=?').run(row.row_id);
    for (const [position, repository] of (run.repositories ?? []).entries()) this.database.prepare('INSERT INTO work_item_run_repositories VALUES (?,?,?,?,?,?,?,?,?,?)').run(row.row_id, position, repository.platform, repository.projectKey, repository.providerHost ?? null, repository.providerProjectId ?? null, repository.name, repository.checkoutPath, repository.baseBranch, repository.role ?? null);
  }

  private readItem(id: string): InventoryItem {
    const row = this.database.prepare('SELECT w.*,r.platform AS project_platform,r.project_key,r.provider_host,r.provider_project_id,r.name AS project_name,r.default_branch,r.web_url AS project_web_url FROM work_items w JOIN repositories r ON r.id=w.owner_repository_id WHERE w.id=?').get(id)!;
    const sources = this.database.prepare('SELECT source_id AS id,source_type AS type,title,reference,role,platform,project_key AS projectKey,issue_number AS issueNumber,web_url AS webUrl FROM work_item_sources WHERE work_item_id=? ORDER BY position').all(id).map(clean);
    const repositories = this.database.prepare('SELECT wr.association_id AS id,r.platform,r.project_key AS projectKey,r.provider_host AS providerHost,r.provider_project_id AS providerProjectId,r.name,r.default_branch AS defaultBranch,r.web_url AS webUrl,wr.role,wr.checkout_path AS checkoutPath,wr.base_branch AS baseBranch FROM work_item_repositories wr JOIN repositories r ON r.id=wr.repository_id WHERE wr.work_item_id=? ORDER BY wr.position').all(id).map(clean) as unknown as InventoryRepository[];
    const dependsOn = this.database.prepare('SELECT depends_on_id FROM work_item_dependencies WHERE work_item_id=? ORDER BY position').all(id).map(row => String(row.depends_on_id));
    const tags = this.database.prepare('SELECT tag FROM work_item_tags WHERE work_item_id=? ORDER BY position').all(id).map(row => String(row.tag));
    const executionPlan = this.database.prepare('SELECT step_id AS id,title,detail,status FROM work_item_steps WHERE work_item_id=? ORDER BY position').all(id).map(clean) as unknown as InventoryStep[];
    const runRows = this.database.prepare('SELECT * FROM work_item_run_receipts WHERE work_item_id=? AND projection_source=\'inventory\' ORDER BY started_at,run_id').all(id);
    const runs = runRows.map(run => ({ id: String(run.run_id), status: run.status, startedAt: run.started_at, ...(run.completed_at ? { completedAt: run.completed_at } : {}), ...(run.workflow ? { workflow: run.workflow } : {}), ...(run.working_branch ? { workingBranch: run.working_branch } : {}), ...(run.workspace_path ? { workspacePath: run.workspace_path } : {}), ...(run.pid ? { pid: run.pid } : {}), ...(run.error ? { error: run.error } : {}), ...(run.repositories_present ? { repositories: this.database.prepare('SELECT platform,project_key AS projectKey,provider_host AS providerHost,provider_project_id AS providerProjectId,name,checkout_path AS checkoutPath,base_branch AS baseBranch,role FROM work_item_run_repositories WHERE run_receipt_row_id=? ORDER BY position').all(run.row_id).map(clean) } : {}) })) as InventoryRun[];
    return { id: String(row.id), issueNumber: Number(row.issue_number), project: this.projectFromRow(row), title: String(row.title), ...(row.description !== null ? { description: String(row.description) } : {}), managed: Boolean(row.managed), executionEligible: Boolean(row.execution_eligible), state: String(row.state) as InventoryItem['state'], executionMode: String(row.execution_mode) as InventoryItem['executionMode'], ...(row.parent_id ? { parentId: String(row.parent_id) } : {}), dependsOn, tags, branchName: String(row.branch_name), providerRef: String(row.provider_ref), ...(row.web_url ? { webUrl: String(row.web_url) } : {}), ...(Number(row.sources_present) ? { sources: sources as unknown as InventorySource[] } : {}), ...(Number(row.repositories_present) ? { repositories } : {}), ...(Number(row.execution_plan_present) ? { executionPlan } : {}), ...(Number(row.runs_present) ? { runs } : {}), ...(row.owner ? { owner: String(row.owner) } : {}), ...(row.priority ? { priority: String(row.priority) as InventoryItem['priority'] } : {}), ...(row.provider_updated_at ? { updatedAt: String(row.provider_updated_at) } : {}) };
  }

  private projectFromRow(row: Row): InventoryProject { return { platform: String(row.project_platform ?? row.platform) as InventoryProject['platform'], projectKey: String(row.project_key ?? row.projectKey), ...(row.provider_host ? { providerHost: String(row.provider_host) } : {}), ...(row.provider_project_id ? { providerProjectId: String(row.provider_project_id) } : {}), name: String(row.project_name ?? row.name), ...(row.default_branch ? { defaultBranch: String(row.default_branch) } : {}), ...(row.project_web_url ?? row.web_url ? { webUrl: String(row.project_web_url ?? row.web_url) } : {}) }; }
  private scopeId(scope: InventoryScope): number { const row = this.database.prepare('SELECT id FROM sync_scopes WHERE platform=? AND host_key=? AND scope_kind=? AND project_key=?').get(scope.platform, scope.host, scope.kind, scope.projectKey ?? ''); return row ? Number(row.id) : Number((this.database.prepare('SELECT coalesce(max(id),0)+1 AS id FROM sync_scopes').get()!).id); }
  private revision(): number { return Number(this.database.prepare('SELECT revision FROM inventory_meta WHERE singleton=1').get()!.revision); }
  private bumpRevision(): void { this.database.prepare('UPDATE inventory_meta SET revision=revision+1 WHERE singleton=1').run(); }
  private complete(): boolean { const rows = this.database.prepare("SELECT count(*) AS total FROM sync_scopes WHERE last_status NOT IN ('success','never')").get(); return Number(rows!.total) === 0; }
  private lastSuccessAt(): number | undefined { const value = this.database.prepare("SELECT max(last_success_at_ms) AS value FROM sync_scopes WHERE last_status = 'success'").get()?.value; return value === null || value === undefined ? undefined : Number(value); }
  private diagnostics(): InventoryDiagnostic[] { return this.database.prepare('SELECT platform,project_key AS projectKey,code,message,retryable FROM sync_diagnostics ORDER BY id').all().map(row => ({ platform: row.platform, ...(row.projectKey ? { projectKey: row.projectKey } : {}), code: row.code, message: row.message, retryable: Boolean(row.retryable) })) as InventoryDiagnostic[]; }
  private replaceDiagnostics(scopeId: number, sequence: number, diagnostics: readonly InventoryDiagnostic[], now: number): void { this.database.prepare('DELETE FROM sync_diagnostics WHERE sync_scope_id=? AND attempt_seq=?').run(scopeId, sequence); for (const diagnostic of diagnostics) this.database.prepare('INSERT INTO sync_diagnostics(sync_scope_id,attempt_seq,platform,project_key,code,message,retryable,observed_at_ms) VALUES (?,?,?,?,?,?,?,?)').run(scopeId, sequence, diagnostic.platform, diagnostic.projectKey ?? null, diagnostic.code, diagnostic.message, bool(diagnostic.retryable), now); }
}

function bool(value: boolean): number { return value ? 1 : 0; }
function clean(row: Row): Row { return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)); }
function parseLimit(value: number | undefined): number { if (value === undefined) return LIMIT_DEFAULT; if (!Number.isInteger(value) || value < 1 || value > LIMIT_MAX) throw new Error(`limit must be between 1 and ${LIMIT_MAX}`); return value; }
function encodeCursor(cursor: { revision: number; filter: string; time?: string; id: string }): string { return Buffer.from(JSON.stringify({ ...cursor, hash: createHash('sha256').update(cursor.filter).digest('hex') })).toString('base64url'); }
function decodeCursor(value: string | undefined, revision: number, filter: string): { time: string; id: string } | { id: string } | undefined { if (!value) return undefined; let cursor: { revision?: number; filter?: string; hash?: string; time?: string; id?: string }; try { cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw new Error('invalid cursor'); } if (cursor.revision !== revision) throw new Error('CURSOR_EXPIRED'); if (cursor.filter !== filter || cursor.hash !== createHash('sha256').update(filter).digest('hex') || !cursor.id) throw new Error('cursor does not match query'); return cursor.time === undefined ? { id: cursor.id } : { time: cursor.time, id: cursor.id }; }
