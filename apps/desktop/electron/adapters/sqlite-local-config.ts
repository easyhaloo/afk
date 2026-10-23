import type {
  BastionInput as LocalBastionInput,
  BastionRecord as LocalBastionRecord,
  LocalConfigStore,
  ManagedSshHostInput as LocalHostInput,
  ManagedSshHostRecord as LocalHostRecord,
} from "@afk/application";
import type { BastionInput, BastionRecord } from "./jumpserver-store.js";
import type { ManagedSshHostInput, ManagedSshHostRecord } from "../../shared/ssh-contract.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createJumpserverStore } from "./jumpserver-store.js";
import { createSshManagedHostStore } from "./ssh-managed-host-store.js";

export type SshManagedHostStore = {
  list: () => Promise<ManagedSshHostRecord[]>;
  upsert: (input: ManagedSshHostInput) => Promise<ManagedSshHostRecord>;
  update: (id: string, input: ManagedSshHostInput) => Promise<ManagedSshHostRecord>;
  remove: (id: string) => Promise<boolean>;
};

export type JumpserverStore = {
  list: () => Promise<BastionRecord[]>;
  get: (id: string) => Promise<BastionRecord | undefined>;
  getByAlias: (alias: string) => Promise<BastionRecord | undefined>;
  upsert: (input: BastionInput) => Promise<BastionRecord>;
  update: (id: string, partial: Partial<BastionInput>) => Promise<BastionRecord>;
  remove: (id: string) => Promise<boolean>;
};

type Ready = () => Promise<void>;

function toLocalHost(input: ManagedSshHostInput): LocalHostInput {
  return input;
}

function fromLocalHost(record: LocalHostRecord): ManagedSshHostRecord {
  return {
    id: record.id,
    alias: record.alias,
    hostname: record.hostname,
    port: record.port,
    user: record.user,
    identityFile: record.identityFile,
    proxyJump: record.proxyJump,
    jumpHostType: record.jumpHostType,
    jumpHost: record.jumpHost,
    remoteWorkspace: record.remoteWorkspace,
  };
}

function toLocalBastion(input: BastionInput): LocalBastionInput {
  const { otpSecret: _otpSecret, ...rest } = input;
  return rest;
}

function fromLocalBastion(record: LocalBastionRecord): BastionRecord {
  return {
    id: record.id,
    alias: record.alias,
    hostname: record.hostname,
    port: record.port,
    user: record.user,
    syncFilter: record.syncFilter,
    jmsServerAlias: record.jmsServerAlias,
    lastSyncedAt: record.lastSyncedAt,
    lastSyncAssetCount: record.lastSyncAssetCount,
    lastSyncSkippedCount: record.lastSyncSkippedCount,
  };
}

export function createSqliteSshManagedHostStore(store: LocalConfigStore, ready?: Ready): SshManagedHostStore {
  return {
    async list() {
      await ready?.();
      return (await store.listHosts()).map(fromLocalHost);
    },
    async upsert(input) {
      await ready?.();
      return fromLocalHost(await store.upsertHost(toLocalHost(input)));
    },
    async update(id, input) {
      await ready?.();
      return fromLocalHost(await store.updateHost(id, toLocalHost(input)));
    },
    async remove(id) {
      await ready?.();
      try {
        await store.removeHost(id);
        return true;
      } catch (error) {
        if (error instanceof Error && error.message.includes("not found")) return false;
        throw error;
      }
    },
  };
}

export function createSqliteJumpserverStore(store: LocalConfigStore, ready?: Ready): JumpserverStore {
  return {
    async list() {
      await ready?.();
      return (await store.listBastions()).map(fromLocalBastion);
    },
    async get(id) {
      await ready?.();
      const record = await store.getBastion(id);
      return record && fromLocalBastion(record);
    },
    async getByAlias(alias) {
      await ready?.();
      const record = await store.getBastionByAlias(alias);
      return record && fromLocalBastion(record);
    },
    async upsert(input) {
      await ready?.();
      return fromLocalBastion(await store.upsertBastion(toLocalBastion(input)));
    },
    async update(id, partial) {
      await ready?.();
      const { otpSecret: _otpSecret, ...safePartial } = partial;
      return fromLocalBastion(await store.updateBastion(id, safePartial));
    },
    async remove(id) {
      await ready?.();
      try {
        await store.removeBastion(id);
        return true;
      } catch (error) {
        if (error instanceof Error && error.message.includes("not found")) return false;
        throw error;
      }
    },
  };
}

export function createLegacyLocalConfigReady(
  store: LocalConfigStore,
  options: { hostFile: string; bastionFile: string },
): Ready {
  let migration: Promise<void> | undefined;
  return () => {
    if (!migration) migration = importLegacyLocalConfig(store, options);
    return migration;
  };
}

async function importLegacyLocalConfig(store: LocalConfigStore, options: { hostFile: string; bastionFile: string }): Promise<void> {
  const sources: Array<{ sourceKey: string; sha256: string; kind: "hosts" | "bastions" }> = [];
  for (const [file, kind] of [[options.hostFile, "hosts"], [options.bastionFile, "bastions"]] as const) {
    try {
      const content = await readFile(file, "utf8");
      sources.push({ sourceKey: `legacy:${kind}:${path.resolve(file)}`, sha256: createHash("sha256").update(content).digest("hex"), kind });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const pendingSources = [];
  for (const source of sources) if (!(await store.hasImport(source.sourceKey))) pendingSources.push(source);
  if (!pendingSources.length) return;

  const hostStore = createSshManagedHostStore({ file: options.hostFile });
  const bastionStore = createJumpserverStore({ file: options.bastionFile });
  const hostSource = pendingSources.find(source => source.kind === "hosts");
  const bastionSource = pendingSources.find(source => source.kind === "bastions");
  const hosts = hostSource ? (await hostStore.list()).map(host => ({ ...host, sourceKey: hostSource.sourceKey })) : [];
  const bastions = bastionSource ? (await bastionStore.list()).map(({ otpSecret: _otpSecret, ...bastion }) => ({ ...bastion, sourceKey: bastionSource.sourceKey })) : [];
  await store.importConfiguration({ sources: pendingSources, hosts, bastions });
}
