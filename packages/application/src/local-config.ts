export type JumpHostType = 'openssh' | 'jumpserver' | 'none';

export interface ManagedSshHostInput {
  id?: string;
  alias: string;
  hostname: string;
  port?: number;
  user?: string;
  identityFile?: string;
  proxyJump?: string;
  jumpHostType?: JumpHostType;
  jumpHost?: string;
  remoteWorkspace?: string;
  bastionId?: string;
  sourceKey?: string;
}

export interface ManagedSshHostRecord extends Omit<ManagedSshHostInput, 'id' | 'port' | 'jumpHostType'> {
  id: string;
  port: number;
  jumpHostType?: JumpHostType;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface BastionInput {
  id?: string;
  alias: string;
  hostname: string;
  port: number;
  user: string;
  jmsServerAlias: string;
  syncFilter: { linuxOnly: boolean };
  lastSyncedAt?: string;
  lastSyncAssetCount?: number;
  lastSyncSkippedCount?: number;
  sourceKey?: string;
}

export interface BastionRecord extends Omit<BastionInput, 'id'> {
  id: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface LocalConfigSource {
  sourceKey: string;
  sha256: string;
}

export interface LocalConfigImport {
  sources: readonly LocalConfigSource[];
  hosts: readonly ManagedSshHostInput[];
  bastions: readonly BastionInput[];
}

export interface LocalConfigImportResult {
  importedSources: string[];
  skippedSources: string[];
  importedHosts: number;
  importedBastions: number;
  diagnostics: string[];
  revision: number;
}

export interface LocalConfigStore {
  listHosts(): Promise<ManagedSshHostRecord[]>;
  getHost(id: string): Promise<ManagedSshHostRecord | undefined>;
  upsertHost(input: ManagedSshHostInput, expectedRevision?: number): Promise<ManagedSshHostRecord>;
  updateHost(id: string, input: ManagedSshHostInput, expectedRevision?: number): Promise<ManagedSshHostRecord>;
  removeHost(id: string, expectedRevision?: number): Promise<void>;
  listBastions(): Promise<BastionRecord[]>;
  getBastion(id: string): Promise<BastionRecord | undefined>;
  getBastionByAlias(alias: string): Promise<BastionRecord | undefined>;
  upsertBastion(input: BastionInput, expectedRevision?: number): Promise<BastionRecord>;
  updateBastion(id: string, input: Partial<BastionInput>, expectedRevision?: number): Promise<BastionRecord>;
  removeBastion(id: string, options?: { removeHosts?: boolean; expectedRevision?: number }): Promise<void>;
  revision(): Promise<number>;
  hasImport(sourceKey: string): Promise<boolean>;
  importConfiguration(input: LocalConfigImport, expectedRevision?: number): Promise<LocalConfigImportResult>;
}
