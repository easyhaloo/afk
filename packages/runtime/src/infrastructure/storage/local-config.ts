import { randomUUID } from 'node:crypto';
import type {
  BastionInput,
  BastionRecord,
  JumpHostType,
  LocalConfigImport,
  LocalConfigImportResult,
  LocalConfigSource,
  LocalConfigStore,
  ManagedSshHostInput,
  ManagedSshHostRecord,
} from '@afk/application';
import { localStoragePaths } from './paths.js';
import { openSqlite, transaction, type SqliteDatabase } from './sqlite.js';
import { localConfigSchema } from './local-config-schema.js';

type WriteOperation<Result> = (database: SqliteDatabase) => Result;
type Row = { [column: string]: unknown };

const ownSecretKey = /secret|password|credential|token|private[_-]?key|otp/i;

function fail(message: string): never {
  throw new Error(`Invalid local configuration: ${message}`);
}

function text(value: unknown, field: string, required = true): string | undefined {
  if (value === undefined || value === null) {
    if (required) fail(`${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string' || !value.trim()) fail(`${field} must be a non-empty string`);
  return value;
}

function id(value: unknown, field: string): string {
  const result = text(value, field);
  if (!result!.startsWith('managed:') || result!.length <= 'managed:'.length) fail(`${field} must use the managed: prefix`);
  return result!;
}

function port(value: unknown, field: string, fallback?: number): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isInteger(result) || result < 1 || result > 65535) fail(`${field} must be an integer between 1 and 65535`);
  return result;
}

function count(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) fail(`${field} must be a non-negative integer`);
  return value;
}

function assertNoSecrets(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (ownSecretKey.test(key)) throw new Error('Local configuration must not contain credential or secret fields');
    assertNoSecrets(child);
  }
}

function sha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) fail('source sha256 must be 64 hexadecimal characters');
  return value.toLowerCase();
}

function sourceKey(value: unknown): string {
  return text(value, 'sourceKey')!;
}

function mapBastion(row: Row): BastionRecord {
  return {
    id: String(row.id), alias: String(row.alias), hostname: String(row.hostname), port: Number(row.port),
    user: String(row.username), jmsServerAlias: String(row.jms_server_alias), syncFilter: { linuxOnly: Number(row.linux_only) === 1 },
    lastSyncedAt: row.last_synced_at === null ? undefined : String(row.last_synced_at),
    lastSyncAssetCount: row.last_sync_asset_count === null ? undefined : Number(row.last_sync_asset_count),
    lastSyncSkippedCount: row.last_sync_skipped_count === null ? undefined : Number(row.last_sync_skipped_count),
    createdAtMs: Number(row.created_at_ms), updatedAtMs: Number(row.updated_at_ms),
  };
}

function mapHost(row: Row): ManagedSshHostRecord {
  const jumpHostType = row.jump_host_type === null ? undefined : row.jump_host_type as JumpHostType;
  return {
    id: String(row.id), alias: String(row.alias), hostname: String(row.hostname), port: Number(row.port),
    user: row.username === null ? undefined : String(row.username),
    identityFile: row.identity_file === null ? undefined : String(row.identity_file),
    proxyJump: row.legacy_proxy_jump === null ? undefined : String(row.legacy_proxy_jump),
    jumpHostType, jumpHost: row.jump_host_reference === null ? undefined : String(row.jump_host_reference),
    remoteWorkspace: row.remote_workspace === null ? undefined : String(row.remote_workspace),
    bastionId: row.bastion_id === null ? undefined : String(row.bastion_id),
    createdAtMs: Number(row.created_at_ms), updatedAtMs: Number(row.updated_at_ms),
  };
}

function validateHost(input: ManagedSshHostInput): void {
  assertNoSecrets(input);
  text(input.alias, 'alias');
  text(input.hostname, 'hostname');
  if (input.id !== undefined) id(input.id, 'id');
  port(input.port, 'port', 22);
  for (const [value, field] of [[input.user, 'user'], [input.identityFile, 'identityFile'], [input.proxyJump, 'proxyJump'], [input.jumpHost, 'jumpHost'], [input.remoteWorkspace, 'remoteWorkspace']] as const) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) fail(`${field} must be a non-empty string`);
  }
  const jumpHostType = input.jumpHostType === 'none' ? undefined : input.jumpHostType;
  if (jumpHostType !== undefined && jumpHostType !== 'openssh' && jumpHostType !== 'jumpserver') fail('jumpHostType is unsupported');
  if (jumpHostType === undefined && input.jumpHost !== undefined) fail('jumpHost requires jumpHostType');
  if (jumpHostType !== undefined && !input.jumpHost?.trim()) fail('jumpHost is required for a jump route');
  if (input.bastionId !== undefined) id(input.bastionId, 'bastionId');
  if (input.bastionId !== undefined && jumpHostType !== 'jumpserver') fail('bastionId requires a JumpServer route');
}

function validateBastion(input: BastionInput): void {
  assertNoSecrets(input);
  if (input.id !== undefined) id(input.id, 'id');
  text(input.alias, 'alias'); text(input.hostname, 'hostname'); text(input.user, 'user'); text(input.jmsServerAlias, 'jmsServerAlias');
  port(input.port, 'port');
  if (!input.syncFilter || typeof input.syncFilter.linuxOnly !== 'boolean') fail('syncFilter.linuxOnly must be boolean');
  if (input.lastSyncedAt !== undefined) text(input.lastSyncedAt, 'lastSyncedAt');
  count(input.lastSyncAssetCount, 'lastSyncAssetCount'); count(input.lastSyncSkippedCount, 'lastSyncSkippedCount');
}

export class SqliteLocalConfigStore implements LocalConfigStore {
  private readonly database: SqliteDatabase;

  constructor(options: { file?: string; root?: string; durability?: 'FULL' | 'NORMAL' } = {}) {
    this.database = openSqlite({
      file: options.file ?? localStoragePaths(options.root).config,
      schema: localConfigSchema,
      durability: options.durability,
      initialize: database => {
        database.prepare('INSERT INTO local_config_meta (singleton, created_at_ms) SELECT 1, ? WHERE NOT EXISTS (SELECT 1 FROM local_config_meta)').run(Date.now());
      },
    });
  }

  close(): void { this.database.close(); }

  async revision(): Promise<number> {
    return Number(this.database.prepare('SELECT revision FROM local_config_meta WHERE singleton = 1').get()?.revision ?? 0);
  }

  async hasImport(sourceKey: string): Promise<boolean> {
    return Boolean(this.database.prepare('SELECT 1 FROM local_config_imports WHERE source_key = ?').get(sourceKey));
  }

  async listHosts(): Promise<ManagedSshHostRecord[]> {
    return this.database.prepare('SELECT * FROM ssh_managed_hosts ORDER BY alias').all().map(mapHost);
  }

  async getHost(hostId: string): Promise<ManagedSshHostRecord | undefined> {
    return this.rowHost(hostId);
  }

  async listBastions(): Promise<BastionRecord[]> {
    return this.database.prepare('SELECT * FROM ssh_bastions ORDER BY alias').all().map(mapBastion);
  }

  async getBastion(bastionId: string): Promise<BastionRecord | undefined> {
    return this.rowBastion(bastionId);
  }

  async getBastionByAlias(alias: string): Promise<BastionRecord | undefined> {
    const row = this.database.prepare('SELECT * FROM ssh_bastions WHERE alias = ?').get(alias);
    return row ? mapBastion(row) : undefined;
  }

  async upsertHost(input: ManagedSshHostInput, expectedRevision?: number): Promise<ManagedSshHostRecord> {
    validateHost(input);
    return this.write(expectedRevision, database => this.saveHost(database, input));
  }

  async updateHost(hostId: string, input: ManagedSshHostInput, expectedRevision?: number): Promise<ManagedSshHostRecord> {
    const existing = this.rowHost(hostId);
    if (!existing) throw new Error(`Host ${hostId} not found`);
    validateHost({ ...existing, ...input, id: hostId });
    return this.write(expectedRevision, database => this.saveHost(database, { ...existing, ...input, id: hostId }));
  }

  async removeHost(hostId: string, expectedRevision?: number): Promise<void> {
    await this.write(expectedRevision, database => {
      if (!this.rowHost(hostId)) throw new Error(`Host ${hostId} not found`);
      database.prepare('DELETE FROM ssh_managed_hosts WHERE id = ?').run(hostId);
    });
  }

  async upsertBastion(input: BastionInput, expectedRevision?: number): Promise<BastionRecord> {
    validateBastion(input);
    return this.write(expectedRevision, database => this.saveBastion(database, input));
  }

  async updateBastion(bastionId: string, input: Partial<BastionInput>, expectedRevision?: number): Promise<BastionRecord> {
    const existing = this.rowBastion(bastionId);
    if (!existing) throw new Error(`Bastion ${bastionId} not found`);
    const merged = { ...existing, ...input, id: bastionId };
    validateBastion(merged);
    return this.write(expectedRevision, database => this.saveBastion(database, merged, existing));
  }

  async removeBastion(bastionId: string, options: { removeHosts?: boolean; expectedRevision?: number } = {}): Promise<void> {
    const existing = this.rowBastion(bastionId);
    if (!existing) throw new Error(`Bastion ${bastionId} not found`);
    await this.write(options.expectedRevision, database => {
      if (options.removeHosts) {
        database.prepare("DELETE FROM ssh_managed_hosts WHERE jump_host_type = 'jumpserver' AND (bastion_id = ? OR jump_host_reference IN (?, ?))")
          .run(bastionId, existing.alias, bastionId);
      }
      database.prepare('DELETE FROM ssh_bastions WHERE id = ?').run(bastionId);
    });
  }

  async importConfiguration(input: LocalConfigImport, expectedRevision?: number): Promise<LocalConfigImportResult> {
    assertNoSecrets(input);
    const sources = input.sources.map(source => ({ sourceKey: sourceKey(source.sourceKey), sha256: sha256(source.sha256) }));
    if (!sources.length || new Set(sources.map(source => source.sourceKey)).size !== sources.length) fail('sources must have unique sourceKey values');
    if (input.hosts.some(host => input.sources.length > 1 && host.sourceKey === undefined) || input.bastions.some(bastion => input.sources.length > 1 && bastion.sourceKey === undefined)) fail('rows need sourceKey when importing multiple sources');
    for (const host of input.hosts) validateHost(host);
    for (const bastion of input.bastions) validateBastion(bastion);
    return this.write(expectedRevision, database => {
      const importedSources: string[] = [];
      const skippedSources: string[] = [];
      const active = new Map<string, LocalConfigSource>();
      for (const source of sources) {
        if (database.prepare('SELECT 1 FROM local_config_imports WHERE source_key = ?').get(source.sourceKey)) skippedSources.push(source.sourceKey);
        else { importedSources.push(source.sourceKey); active.set(source.sourceKey, source); }
      }
      const bastions = input.bastions.filter(row => active.has(row.sourceKey ?? sources[0].sourceKey));
      const hosts = input.hosts.filter(row => active.has(row.sourceKey ?? sources[0].sourceKey));
      const seenIds = new Set<string>();
      const seenAliases = new Set<string>();
      for (const bastion of bastions) {
        const bastionId = bastion.id ?? `managed:${randomUUID()}`;
        if (seenIds.has(bastionId) || seenAliases.has(bastion.alias) || this.rowBastion(bastionId) || this.getBastionByAliasSync(bastion.alias)) throw new Error('Import identity conflict');
        seenIds.add(bastionId); seenAliases.add(bastion.alias);
      }
      for (const host of hosts) {
        const hostId = host.id ?? `managed:${randomUUID()}`;
        if (seenIds.has(hostId) || seenAliases.has(host.alias) || this.rowHost(hostId) || this.getHostByAliasSync(host.alias)) throw new Error('Import identity conflict');
        seenIds.add(hostId); seenAliases.add(host.alias);
      }
      for (const bastion of bastions) this.saveBastion(database, bastion);
      const diagnostics: string[] = [];
      for (const host of hosts) {
        const saved = this.saveHost(database, host, undefined, true);
        if (saved.jumpHostType === 'jumpserver' && !saved.bastionId) diagnostics.push(`Unresolved JumpServer reference: ${saved.jumpHost}`);
      }
      for (const source of importedSources) {
        const sourceBastions = bastions.filter(item => (item.sourceKey ?? sources[0].sourceKey) === source).length;
        const sourceHosts = hosts.filter(item => (item.sourceKey ?? sources[0].sourceKey) === source).length;
        database.prepare('INSERT INTO local_config_imports (source_key, source_sha256, imported_at_ms, imported_hosts, imported_bastions, diagnostic_count) VALUES (?, ?, ?, ?, ?, ?)')
          .run(source, active.get(source)!.sha256, Date.now(), sourceHosts, sourceBastions, diagnostics.length);
      }
      return { importedSources, skippedSources, importedHosts: hosts.length, importedBastions: bastions.length, diagnostics, revision: this.currentRevision(database) + 1 };
    });
  }

  private async write<Result>(expectedRevision: number | undefined, operation: WriteOperation<Result>): Promise<Result> {
    return transaction(this.database, () => {
      const current = this.currentRevision(this.database);
      if (expectedRevision !== undefined && expectedRevision !== current) throw new Error(`Configuration revision conflict: expected ${expectedRevision}, current ${current}`);
      const result = operation(this.database);
      this.database.prepare('UPDATE local_config_meta SET revision = revision + 1 WHERE singleton = 1').run();
      return result;
    });
  }

  private currentRevision(database: SqliteDatabase): number {
    return Number(database.prepare('SELECT revision FROM local_config_meta WHERE singleton = 1').get()?.revision ?? 0);
  }

  private rowHost(hostId: string): ManagedSshHostRecord | undefined {
    const row = this.database.prepare('SELECT * FROM ssh_managed_hosts WHERE id = ?').get(hostId);
    return row ? mapHost(row) : undefined;
  }

  private rowBastion(bastionId: string): BastionRecord | undefined {
    const row = this.database.prepare('SELECT * FROM ssh_bastions WHERE id = ?').get(bastionId);
    return row ? mapBastion(row) : undefined;
  }

  private getHostByAliasSync(alias: string): ManagedSshHostRecord | undefined {
    const row = this.database.prepare('SELECT * FROM ssh_managed_hosts WHERE alias = ?').get(alias);
    return row ? mapHost(row) : undefined;
  }

  private getBastionByAliasSync(alias: string): BastionRecord | undefined {
    const row = this.database.prepare('SELECT * FROM ssh_bastions WHERE alias = ?').get(alias);
    return row ? mapBastion(row) : undefined;
  }

  private saveHost(database: SqliteDatabase, input: ManagedSshHostInput, previous?: ManagedSshHostRecord, importing = false): ManagedSshHostRecord {
    const existingById = input.id ? this.rowHost(input.id) : undefined;
    const existingByAlias = this.getHostByAliasSync(input.alias);
    if (existingById && existingByAlias && existingById.id !== existingByAlias.id) throw new Error('Host identity conflict');
    if (input.id && !existingById && existingByAlias) throw new Error('Host identity conflict');
    if (importing && (existingById || existingByAlias)) throw new Error('Import identity conflict');
    const existing = previous ?? existingById ?? existingByAlias;
    const hostId = input.id ?? existing?.id ?? `managed:${randomUUID()}`;
    const createdAtMs = existing?.createdAtMs ?? Date.now();
    const updatedAtMs = Date.now();
    const jumpHostType = input.jumpHostType === 'none' ? undefined : input.jumpHostType;
    let bastionId: string | undefined;
    if (jumpHostType === 'jumpserver') {
      const bastion = input.bastionId ? this.rowBastion(input.bastionId) : this.getBastionByAliasSync(input.jumpHost!);
      if (input.bastionId && !bastion) fail('bastionId does not exist');
      if (bastion && input.jumpHost !== bastion.alias && input.jumpHost !== bastion.id) fail('jumpHost does not match bastionId');
      bastionId = bastion?.id;
    }
    const params = [hostId, input.alias, input.hostname, port(input.port, 'port', 22), input.user ?? null, input.identityFile ?? null, input.remoteWorkspace ?? null, input.proxyJump ?? null, jumpHostType ?? null, input.jumpHost ?? null, bastionId ?? null, createdAtMs, updatedAtMs];
    if (existing) database.prepare('UPDATE ssh_managed_hosts SET alias = ?, hostname = ?, port = ?, username = ?, identity_file = ?, remote_workspace = ?, legacy_proxy_jump = ?, jump_host_type = ?, jump_host_reference = ?, bastion_id = ?, updated_at_ms = ? WHERE id = ?').run(params[1], params[2], params[3], params[4], params[5], params[6], params[7], params[8], params[9], params[10], params[12], hostId);
    else database.prepare('INSERT INTO ssh_managed_hosts (id, alias, hostname, port, username, identity_file, remote_workspace, legacy_proxy_jump, jump_host_type, jump_host_reference, bastion_id, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...params);
    return this.rowHost(hostId)!;
  }

  private saveBastion(database: SqliteDatabase, input: BastionInput, previous?: BastionRecord): BastionRecord {
    const existingById = input.id ? this.rowBastion(input.id) : undefined;
    const existingByAlias = this.getBastionByAliasSync(input.alias);
    if (existingById && existingByAlias && existingById.id !== existingByAlias.id) throw new Error('Bastion identity conflict');
    if (input.id && !existingById && existingByAlias) throw new Error('Bastion identity conflict');
    const existing = previous ?? existingById ?? existingByAlias;
    const bastionId = input.id ?? existing?.id ?? `managed:${randomUUID()}`;
    const createdAtMs = existing?.createdAtMs ?? Date.now();
    const oldAlias = existing?.alias;
    database.prepare('INSERT INTO ssh_bastions (id, alias, hostname, port, username, jms_server_alias, linux_only, last_synced_at, last_sync_asset_count, last_sync_skipped_count, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET alias = excluded.alias, hostname = excluded.hostname, port = excluded.port, username = excluded.username, jms_server_alias = excluded.jms_server_alias, linux_only = excluded.linux_only, last_synced_at = excluded.last_synced_at, last_sync_asset_count = excluded.last_sync_asset_count, last_sync_skipped_count = excluded.last_sync_skipped_count, updated_at_ms = excluded.updated_at_ms')
      .run(bastionId, input.alias, input.hostname, input.port, input.user, input.jmsServerAlias, input.syncFilter.linuxOnly ? 1 : 0, input.lastSyncedAt ?? null, input.lastSyncAssetCount ?? null, input.lastSyncSkippedCount ?? null, createdAtMs, Date.now());
    if (oldAlias && oldAlias !== input.alias) database.prepare("UPDATE ssh_managed_hosts SET jump_host_reference = ? WHERE jump_host_type = 'jumpserver' AND (bastion_id = ? OR jump_host_reference IN (?, ?))").run(input.alias, bastionId, oldAlias, bastionId);
    return this.rowBastion(bastionId)!;
  }
}

export { SqliteLocalConfigStore as LocalConfigSqliteStore };
