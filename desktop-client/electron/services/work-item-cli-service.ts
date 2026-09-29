import path from "node:path";

type CliDeps = {
  appPath: string;
  packaged: boolean;
  configuredCli?: string;
  exists: (file: string) => Promise<boolean>;
  which: () => Promise<string>;
  help: (command: string) => Promise<{ ok: boolean; stdout: string }>;
};

export async function resolveWorkItemCli(deps: CliDeps): Promise<string> {
  const localEntry = path.resolve(deps.appPath, "../dist/index.js");
  const candidate = deps.configuredCli ?? (!deps.packaged && await deps.exists(localEntry) ? localEntry : await deps.which());
  if (!path.isAbsolute(candidate)) throw new Error("afk CLI 未在 PATH 中发现");
  const help = await deps.help(candidate);
  if (!help.ok || !help.stdout.includes("--execution-manifest") || !help.stdout.includes("--work-item-id")) {
    throw new Error("当前 afk CLI 不支持 execute --work-item-id --execution-manifest；请构建或安装支持完整工作项执行的版本");
  }
  return candidate;
}
