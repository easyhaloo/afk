import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type { RuntimeEvent } from "../../shared/ipc-contract";

export function resolveWorkspace(input?: string) {
  const candidate = input?.trim() || process.env.AFK_WORKSPACE || path.resolve(process.cwd(), "..");
  const root = path.resolve(candidate);
  if (!existsSync(root)) throw new Error(`无法访问工作区：${root}`);
  return root;
}

async function eventFiles(root: string) {
  const runRoot = path.join(root, ".afk", "runs");
  if (!existsSync(runRoot)) return [] as string[];
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      if (entry.isFile() && entry.name === "events.jsonl") files.push(target);
      if (files.length >= 10) return;
    }
  };
  await walk(runRoot);
  return files.sort().reverse();
}

export async function readEvents(root: string): Promise<RuntimeEvent[]> {
  const output: RuntimeEvent[] = [];
  for (const file of await eventFiles(root)) {
    const source = path.basename(path.dirname(file));
    const lines = (await fs.readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).reverse();
    for (const raw of lines) {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { /* retain raw event */ }
      const text = (key: string) => typeof parsed[key] === "string" ? String(parsed[key]) : undefined;
      output.push({
        id: `${source}-${createHash("sha1").update(raw).digest("hex").slice(0, 12)}`,
        timestamp: text("timestamp") || text("at") || text("time") || "—",
        source,
        status: text("status") || text("state") || text("phase") || text("event"),
        result: text("message") || text("event") || text("type") || "AFK 运行事件",
        nextStep: text("nextStep") || text("next_step") || "打开运行检查器查看详情",
        raw,
      });
      if (output.length >= 160) return output;
    }
  }
  return output;
}
