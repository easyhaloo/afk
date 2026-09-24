import path from "node:path";
import type { ManagedSshHostRecord } from "../../shared/ssh-contract";
import type { BastionInput, BastionRecord } from "../adapters/jumpserver-store";
import { createJumpserverStore } from "../adapters/jumpserver-store";
import { JUMPSERVER_BINARY_ERROR, createJumpserverCli } from "../adapters/jumpserver-cli";
import { createJumpserverCredentialStore } from "./jumpserver-credential-service";

// Must match OPENSSH_ALIAS_PATTERN in ../security/ssh-validation.ts
const ALIAS_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

export type SyncResult = {
  bastionId: string;
  assetsDiscovered: number;
  assetsCreated: number;
  assetsSkipped: number;
  skippedReasons: Array<{ name: string; reason: string }>;
  createdAssetIds: string[];
  syncedAt: string;
};

export type AddBastionInput = {
  alias: string;
  hostname: string;
  port: number;
  user: string;
  password: string;
  otpSecret?: string;
  linuxOnly?: boolean;
};

export type AddBastionResult = {
  bastion: BastionRecord;
  assetPreview: Array<{ name: string; address: string; platform: string }>;
};

export type SshBastionSyncLogEntry = {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
};

type JumpserverServiceDeps = {
  home: string;
  bastionStore?: ReturnType<typeof createJumpserverStore>;
  credentialService?: ReturnType<typeof createJumpserverCredentialStore>;
  cli?: ReturnType<typeof createJumpserverCli>;
  managedHostStore?: ReturnType<typeof import("../adapters/ssh-managed-host-store").createSshManagedHostStore>;
  listManagedHosts?: () => Promise<{ hosts: ManagedSshHostRecord[] }>;
  audit?: (event: { kind: string; bastionId: string; at: string; created?: number; skipped?: number }) => void;
};

export function createJumpserverService(deps: JumpserverServiceDeps) {
  const home = deps.home;
  const bastionStore =
    deps.bastionStore ??
    createJumpserverStore({ file: path.join(home, ".config", "afk", "jumpserver-bastions.yml") });
  const credentialService =
    deps.credentialService ??
    createJumpserverCredentialStore({ home, safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => "" } });
  const cli = deps.cli ?? createJumpserverCli();

  // In-memory sync log ring buffer: 50 entries per bastion, newest first.
  const syncLogs = new Map<string, SshBastionSyncLogEntry[]>();
  const MAX_LOG_ENTRIES = 50;

  function appendSyncLog(bastionId: string, entry: SshBastionSyncLogEntry) {
    const entries = syncLogs.get(bastionId) ?? [];
    entries.unshift(entry);
    if (entries.length > MAX_LOG_ENTRIES) entries.length = MAX_LOG_ENTRIES;
    syncLogs.set(bastionId, entries);
  }

  async function listBastions(): Promise<BastionRecord[]> {
    return bastionStore.list();
  }

  async function getBastion(id: string): Promise<BastionRecord | undefined> {
    return bastionStore.get(id);
  }

  async function addBastion(input: AddBastionInput): Promise<AddBastionResult> {
    // Step 1: resolve binary path
    const binaryPath = await cli.resolveBinaryPath();
    if (!binaryPath) throw new Error(JUMPSERVER_BINARY_ERROR);

    // Step 2: add server in jms CLI
    const addResult = await cli.addServer({
      alias: input.alias,
      host: input.hostname,
      port: input.port,
      username: input.user,
      password: input.password,
    });
    if (!addResult.ok) throw new Error(`JumpServer 添加服务器失败: ${input.alias}`);

    // Step 3: preview assets
    const linuxOnly = input.linuxOnly ?? true;
    const rawAssets = await cli.listAssets(input.alias, { linuxOnly });
    const assetPreview = rawAssets.map((a) => ({ name: a.name, address: a.address, platform: a.platform }));

    const target = { hostname: input.hostname, port: input.port, user: input.user };

    // Step 4: upsert bastion record
    const bastion = await bastionStore.upsert({
      alias: input.alias,
      hostname: input.hostname,
      port: input.port,
      user: input.user,
      otpSecret: input.otpSecret,
      syncFilter: { linuxOnly },
      jmsServerAlias: input.alias,
    });

    // Step 5: store credential keyed by the bastion id so syncAssets/removeBastion can find it
    await credentialService.set(bastion.id, input.password, target, input.otpSecret);

    return { bastion, assetPreview };
  }

  async function updateBastion(id: string, partial: Partial<BastionInput>): Promise<BastionRecord> {
    const existing = await bastionStore.get(id);
    if (!existing) throw new Error("堡垒机不存在");
    return bastionStore.update(id, partial);
  }

  async function removeBastion(id: string): Promise<{ ok: true; removedAssetCount: number }> {
    const bastion = await bastionStore.get(id);
    if (!bastion) throw new Error("堡垒机不存在");

    // Step 1: remove managed hosts that belong to this bastion
    let removedAssetCount = 0;
    if (deps.listManagedHosts && deps.managedHostStore) {
      const { hosts } = await deps.listManagedHosts();
      const toRemove = hosts.filter((h) => h.jumpHost === bastion.alias && h.jumpHostType === "jumpserver");
      for (const host of toRemove) {
        await deps.managedHostStore.remove(host.id);
        removedAssetCount++;
      }
    }

    // Step 2: remove from jms CLI
    await cli.removeServer(bastion.jmsServerAlias);

    // Step 3: remove credential
    await credentialService.remove(bastion.id);

    // Step 4: remove bastion record
    await bastionStore.remove(bastion.id);

    return { ok: true, removedAssetCount };
  }

  async function syncAssets(
    bastionId: string,
    opts?: { selectedNames?: string[]; linuxOnly?: boolean },
  ): Promise<SyncResult> {
    const bastion = await bastionStore.get(bastionId);
    if (!bastion) throw new Error("堡垒机不存在");

    const target = { hostname: bastion.hostname, port: bastion.port, user: bastion.user };
    const creds = await credentialService.get(bastionId, target);
    if (!creds) throw new Error("堡垒机凭证缺失");

    // Ensure bastion is registered in jms CLI
    const servers = await cli.listServers();
    if (!servers.some((s) => s.alias === bastion.jmsServerAlias)) {
      await cli.addServer({
        alias: bastion.jmsServerAlias,
        host: bastion.hostname,
        port: bastion.port,
        username: bastion.user,
        password: creds.password,
      });
    }

    const effectiveLinuxOnly = opts?.linuxOnly ?? bastion.syncFilter.linuxOnly;
    const rawAssets = await cli.listAssets(bastion.jmsServerAlias, { linuxOnly: effectiveLinuxOnly });

    const skippedReasons: Array<{ name: string; reason: string }> = [];
    const createdAssetIds: string[] = [];

    const existingHosts = deps.listManagedHosts ? (await deps.listManagedHosts()).hosts : [];

    for (const asset of rawAssets) {
      // Validate alias
      if (!ALIAS_PATTERN.test(asset.name)) {
        skippedReasons.push({ name: asset.name, reason: "资产名称非法" });
        continue;
      }

      // Filter Windows assets when linuxOnly
      if (effectiveLinuxOnly && !asset.platform.startsWith("Linux")) {
        skippedReasons.push({ name: asset.name, reason: "Windows 资产已跳过" });
        continue;
      }

      // Filter by selectedNames
      if (opts?.selectedNames && !opts.selectedNames.includes(asset.name)) {
        skippedReasons.push({ name: asset.name, reason: "未在 selectedNames 中" });
        continue;
      }

      const existing = existingHosts.find((h) => h.alias === asset.name);

      if (existing) {
        if (existing.jumpHost !== bastion.alias) {
          skippedReasons.push({ name: asset.name, reason: "资产已被独立管理，跳过" });
          continue;
        }
        // Update in place via upsert (preserves id for existing alias)
        if (deps.managedHostStore) {
          const record = await deps.managedHostStore.upsert({
            alias: asset.name,
            hostname: asset.address,
            port: 22,
            user: bastion.user,
            jumpHostType: "jumpserver",
            jumpHost: bastion.alias,
          });
          createdAssetIds.push(record.id);
        }
      } else {
        // Create new
        if (deps.managedHostStore) {
          const record = await deps.managedHostStore.upsert({
            alias: asset.name,
            hostname: asset.address,
            port: 22,
            user: bastion.user,
            jumpHostType: "jumpserver",
            jumpHost: bastion.alias,
          });
          createdAssetIds.push(record.id);
        }
      }
    }

    const syncedAt = new Date().toISOString();
    const assetsDiscovered = rawAssets.length;
    const assetsSkipped = skippedReasons.length;

    // Update bastion record with sync stats
    await bastionStore.update(bastionId, {
      lastSyncedAt: syncedAt,
      lastSyncAssetCount: assetsDiscovered,
      lastSyncSkippedCount: assetsSkipped,
    });

    // Append to ring buffer log
    appendSyncLog(bastionId, {
      at: syncedAt,
      level: assetsSkipped > 0 ? "warn" : "info",
      message: `同步完成：发现 ${assetsDiscovered} 资产，新增 ${createdAssetIds.length}，跳过 ${assetsSkipped}`,
    });

    deps.audit?.({ kind: "sync", bastionId, at: syncedAt, created: createdAssetIds.length, skipped: assetsSkipped });

    return { bastionId, assetsDiscovered, assetsCreated: createdAssetIds.length, assetsSkipped, skippedReasons, createdAssetIds, syncedAt };
  }

  function getSyncLog(bastionId: string): SshBastionSyncLogEntry[] {
    return syncLogs.get(bastionId) ?? [];
  }

  return {
    listBastions,
    getBastion,
    addBastion,
    updateBastion,
    removeBastion,
    syncAssets,
    getSyncLog,
  };
}
