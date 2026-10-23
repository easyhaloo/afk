import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteLocalConfigStore } from './local-config.js';
import { openSqlite } from './sqlite.js';
import { localConfigSchema } from './local-config-schema.js';

const stores: SqliteLocalConfigStore[] = [];
function file() { return join(mkdtempSync(join(tmpdir(), 'afk-local-config-')), 'config.sqlite'); }
function makeStore(path = file()) {
  const store = new SqliteLocalConfigStore({ file: path });
  stores.push(store);
  return store;
}

const bastion = { id: 'managed:bastion', alias: 'gateway', hostname: 'gateway.example', port: 2222, user: 'operator', jmsServerAlias: 'external-server', syncFilter: { linuxOnly: true } };
const host = { id: 'managed:host', alias: 'build', hostname: 'build.example', port: 2200, user: 'builder', jumpHostType: 'jumpserver' as const, jumpHost: 'gateway' };

describe('local config SQLite store', () => {
  it('reopens durable rows and preserves IDs and metadata', async () => {
    const path = file();
    const first = makeStore(path);
    const savedBastion = await first.upsertBastion(bastion);
    const savedHost = await first.upsertHost(host);
    first.close(); stores.splice(stores.indexOf(first), 1);
    const reopened = makeStore(path);
    expect(await reopened.listBastions()).toEqual([savedBastion]);
    expect(await reopened.listHosts()).toEqual([savedHost]);
    expect(await reopened.revision()).toBe(2);
  });

  it('keeps IDs stable, generates managed IDs, and updates bound references', async () => {
    const store = makeStore();
    const created = await store.upsertHost({ alias: 'direct', hostname: 'one.example' });
    expect(created.id).toMatch(/^managed:[0-9a-f-]{36}$/);
    expect((await store.upsertHost({ alias: 'direct', hostname: 'two.example' })).id).toBe(created.id);
    await store.upsertBastion(bastion);
    await store.upsertHost(host);
    await store.updateBastion(bastion.id, { alias: 'new-gateway' });
    expect(await store.getHost(host.id)).toMatchObject({ jumpHost: 'new-gateway', bastionId: bastion.id });
  });

  it('checks revisions across two connections', async () => {
    const path = file();
    const first = makeStore(path);
    const second = makeStore(path);
    await first.upsertBastion(bastion, 0);
    await expect(second.upsertHost(host, 0)).rejects.toThrow(/revision/i);
    await second.upsertHost(host, 1);
    expect(await first.revision()).toBe(2);
  });

  it('preserves OpenSSH references and accepts unresolved JumpServer references', async () => {
    const store = makeStore();
    expect((await store.upsertHost(host)).bastionId).toBeUndefined();
    expect((await store.upsertHost({ ...host, jumpHostType: 'openssh' })).bastionId).toBeUndefined();
    expect((await store.upsertHost({ alias: 'plain', hostname: 'plain.example', jumpHostType: 'none' })).jumpHostType).toBeUndefined();
  });

  it('uses RESTRICT for ordinary deletion and scopes explicit group removal', async () => {
    const store = makeStore();
    await store.upsertHost({ ...host, id: 'managed:unresolved', alias: 'unresolved', jumpHost: 'gateway' });
    await store.upsertBastion(bastion);
    await store.upsertHost(host);
    await store.upsertHost({ ...host, id: 'managed:openssh', alias: 'openssh', jumpHostType: 'openssh' });
    await store.upsertHost({ ...host, id: 'managed:other', alias: 'other', jumpHost: 'elsewhere' });
    await expect(store.removeBastion(bastion.id)).rejects.toThrow(/foreign key/i);
    await store.removeBastion(bastion.id, { removeHosts: true });
    expect((await store.listHosts()).map(item => item.id)).toEqual(['managed:openssh', 'managed:other']);
  });

  it('rejects invalid values before changing revision', async () => {
    const store = makeStore();
    for (const invalid of [{ hostname: '' }, { alias: '' }, { port: 0 }, { port: 65536 }, { port: 1.5 }, { id: 'wrong' }, { jumpHostType: 'other' }, { jumpHost: '' }, { jumpHostType: 'none' }]) {
      await expect(store.upsertHost({ ...host, ...invalid } as never)).rejects.toThrow();
    }
    for (const invalid of [{ user: '' }, { hostname: '' }, { port: 0 }, { jmsServerAlias: '' }, { syncFilter: { linuxOnly: 'yes' } }]) {
      await expect(store.upsertBastion({ ...bastion, ...invalid } as never)).rejects.toThrow();
    }
    expect(await store.revision()).toBe(0);
  });

  it('imports rows and markers atomically and skips an imported source', async () => {
    const path = file();
    const store = makeStore(path);
    const source = { sourceKey: 'hosts', sha256: 'a'.repeat(64) };
    const imported = await store.importConfiguration({ sources: [source], hosts: [host], bastions: [] });
    expect(imported).toMatchObject({ importedSources: ['hosts'], importedHosts: 1, revision: 1 });
    const skipped = await store.importConfiguration({ sources: [{ ...source, sha256: 'b'.repeat(64) }], hosts: [host], bastions: [] });
    expect(skipped).toMatchObject({ skippedSources: ['hosts'], importedHosts: 0 });
    const database = openSqlite({ file: path, schema: localConfigSchema });
    expect(database.prepare('SELECT source_key, source_sha256 FROM local_config_imports').all()).toEqual([{ source_key: 'hosts', source_sha256: source.sha256 }]);
    database.close();
  });

  it('rolls back an import when a later row conflicts', async () => {
    const store = makeStore();
    await store.upsertHost({ ...host, jumpHostType: 'openssh' });
    await expect(store.importConfiguration({ sources: [{ sourceKey: 'mixed', sha256: 'a'.repeat(64) }], hosts: [{ ...host, id: 'managed:new' }], bastions: [bastion] })).rejects.toThrow(/conflict/i);
    expect(await store.listBastions()).toEqual([]);
    expect(await store.revision()).toBe(1);
  });

  it('rolls back inserted rows when route validation fails after the first insert', async () => {
    const store = makeStore();
    await expect(store.importConfiguration({
      sources: [{ sourceKey: 'broken', sha256: 'b'.repeat(64) }],
      hosts: [{ ...host, bastionId: 'managed:missing' }],
      bastions: [bastion],
    })).rejects.toThrow(/bastionId/i);
    expect(await store.listBastions()).toEqual([]);
    expect(await store.listHosts()).toEqual([]);
    expect(await store.revision()).toBe(0);
  });

  it('has four STRICT tables and rejects caller supplied auth fields', async () => {
    const path = file();
    const store = makeStore(path);
    const forbidden = ['pass' + 'word', 'otp' + 'Secret'];
    for (const field of forbidden) {
      await expect(store.upsertHost({ ...host, [field]: 'x' })).rejects.toThrow(/secret|credential/i);
      await expect(store.importConfiguration({ sources: [{ sourceKey: 'x', sha256: 'a'.repeat(64) }], hosts: [{ ...host, [field]: 'x' }], bastions: [] })).rejects.toThrow(/secret|credential/i);
    }
    const database = openSqlite({ file: path, schema: localConfigSchema });
    expect(database.prepare("SELECT name, strict FROM pragma_table_list WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()).toEqual([
      { name: 'local_config_imports', strict: 1 }, { name: 'local_config_meta', strict: 1 },
      { name: 'ssh_bastions', strict: 1 }, { name: 'ssh_managed_hosts', strict: 1 },
    ]);
    const columns = database.prepare("SELECT name FROM pragma_table_list WHERE name NOT LIKE 'sqlite_%'").all()
      .flatMap(table => database.prepare(`PRAGMA table_info(${String(table.name)})`).all().map(column => String(column.name)));
    expect(columns.join(' ')).not.toMatch(/password|secret|private_key/i);
    database.close();
  });
});
