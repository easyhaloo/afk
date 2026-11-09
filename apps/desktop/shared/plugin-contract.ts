export type DesktopPluginDiagnostic = {
  pluginId?: string;
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
};

export type DesktopPlugin = {
  id: string;
  version?: string;
  origin: "builtin" | "installed" | "configured";
  enabled: boolean;
  runtimeLoaded: boolean;
  capabilities: string[];
  configurable: boolean;
  removable: boolean;
  configurationPresent?: boolean;
};

export type DesktopPluginList = {
  plugins: DesktopPlugin[];
  diagnostics: DesktopPluginDiagnostic[];
};

export type PluginInstallInput = { kind: "local" } | { kind: "npm"; spec: string };

export type DesktopPluginApi = {
  google: {
    status(): Promise<GoogleAccountStatus>;
    login(): Promise<GoogleAccountStatus | null>;
    cancel(): Promise<void>;
    logout(): Promise<void>;
  };
  list(): Promise<DesktopPluginList>;
  install(input: PluginInstallInput): Promise<boolean>;
  setEnabled(id: string, enabled: boolean): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  configure(id: string): Promise<boolean>;
};

export type GoogleAccountStatus = { connected: boolean; email?: string; expiresAt?: string };

export function parsePluginId(value: unknown): string {
  if (typeof value !== "string" || value.length > 200 || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(value) || /^(?:afk[-.])/.test(value)) throw new Error("插件 ID 无效");
  return value;
}

export function parsePluginEnabled(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("插件启用状态无效");
  return value;
}

export function parsePluginInstall(value: unknown): PluginInstallInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("插件安装来源无效");
  const input = value as Record<string, unknown>;
  if (input.kind === "local" && Object.keys(input).length === 1) return { kind: "local" };
  if (input.kind === "npm" && Object.keys(input).length === 2 && typeof input.spec === "string" && input.spec.length <= 250
    && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9*^~][a-zA-Z0-9.*+^~_-]*)?$/.test(input.spec)) return { kind: "npm", spec: input.spec };
  throw new Error("请输入合法 npm 包名，可带版本或标签；本地插件请使用目录选择器");
}
