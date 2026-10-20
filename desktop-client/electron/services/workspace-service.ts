import { existsSync } from "node:fs";
import path from "node:path";

export function resolveWorkspace(input?: string) {
  const candidate = input?.trim() || process.env.AFK_WORKSPACE || path.resolve(process.cwd(), "..");
  const root = path.resolve(candidate);
  if (!existsSync(root)) throw new Error(`无法访问工作区：${root}`);
  return root;
}


