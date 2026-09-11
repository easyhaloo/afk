import { promises as fs } from "node:fs";
import path from "node:path";

export const WORKSPACE_PREFERENCE_FILE = "workspace.json";

function preferencePath(userDataDirectory: string) {
  return path.join(userDataDirectory, WORKSPACE_PREFERENCE_FILE);
}

export async function readWorkspacePreference(userDataDirectory: string): Promise<string | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(preferencePath(userDataDirectory), "utf8"));
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function saveWorkspacePreference(userDataDirectory: string, workspace: string): Promise<string> {
  const value = workspace.trim();
  if (!value) throw new Error("工作区路径不能为空");
  await fs.mkdir(userDataDirectory, { recursive: true });
  await fs.writeFile(preferencePath(userDataDirectory), JSON.stringify(value) + "\n", "utf8");
  return value;
}
