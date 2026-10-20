import path from "node:path";
import { resolveWorkspace } from "../services/workspace-service.js";

/**
 * The workspace a channel is asked about.
 *
 * The renderer names a workspace and the main process resolves it. A
 * relative path would resolve against whatever the process happens to be
 * in, so the argument has to be absolute.
 */
export function workspaceArgument(value: unknown, operation: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${operation}: workspace 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed && !path.isAbsolute(trimmed)) throw new Error(`${operation}: workspace 必须是绝对路径`);
  return resolveWorkspace(trimmed);
}

/** A tmux session name the caller is allowed to name. */
export function validSession(value: string) {
  return /^[A-Za-z0-9_.:#/-]{1,100}$/.test(value);
}
