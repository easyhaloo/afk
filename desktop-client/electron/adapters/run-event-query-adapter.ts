import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RunEventQueryPort } from "@afk/application";
import type { RunEvent } from "@afk/core";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(entry => entry === undefined ? "null" : stableJson(entry)).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
}

export function createRunEventQueryAdapter(root = join(homedir(), ".afk", "events")): RunEventQueryPort {
  async function load(runId: string): Promise<RunEvent[]> {
    let content: string;
    try {
      content = await fs.readFile(join(root, `${Buffer.from(runId).toString("base64url")}.jsonl`), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return content.split("\n").filter(Boolean).map((line, index) => {
      try {
        const event = JSON.parse(line) as RunEvent;
        if (!event || typeof event.sequence !== "number" || !event.integrity?.hash) throw new Error("invalid event shape");
        return event;
      } catch {
        throw new Error(`cannot parse event ${index + 1} for run '${runId}'`);
      }
    });
  }

  function verifyLoaded(runId: string, events: readonly RunEvent[]) {
    let previous: RunEvent | undefined;
    let count = 0;
    try {
      for (const event of events) {
        if (event.context.runId !== runId) return { valid: false, lastSequence: count, lastHash: previous?.integrity.hash, reason: "run_id_mismatch" };
        if (event.sequence !== count + 1) return { valid: false, lastSequence: count, lastHash: previous?.integrity.hash, reason: "sequence_gap" };
        const { integrity, ...draft } = event;
        const hash = createHash("sha256").update(stableJson({ ...draft, integrity: { prevHash: previous?.integrity.hash } })).digest("hex");
        if (integrity.prevHash !== previous?.integrity.hash || integrity.hash !== hash) {
          return { valid: false, lastSequence: count, lastHash: previous?.integrity.hash, reason: "integrity_mismatch" };
        }
        previous = event;
        count += 1;
      }
      return { valid: true, lastSequence: count, lastHash: previous?.integrity.hash };
    } catch (error) {
      return { valid: false, lastSequence: count, lastHash: previous?.integrity.hash, reason: error instanceof Error ? error.message : "unknown_error" };
    }
  }

  async function verify(runId: string) {
    try {
      return verifyLoaded(runId, await load(runId));
    } catch (error) {
      return { valid: false, lastSequence: 0, reason: error instanceof Error ? error.message : "unknown_error" };
    }
  }

  return {
    async listRuns() {
      let names: string[];
      try {
        names = await fs.readdir(root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      return names.filter(name => name.endsWith(".jsonl"))
        .map(name => Buffer.from(name.slice(0, -6), "base64url").toString("utf8"))
        .filter(Boolean).sort();
    },
    async *read(runId, options) {
      const events = await load(runId);
      const integrity = verifyLoaded(runId, events);
      if (!integrity.valid) throw new Error(`run '${runId}' event integrity: ${integrity.reason}`);
      for (const event of events) {
        if (event.sequence > (options?.afterSequence ?? 0)) yield event;
      }
    },
    verify,
  };
}
