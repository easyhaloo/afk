import { JsonlEventStore } from "@afk/infrastructure/observability";
import type { RunEventQueryPort } from "@afk/application";

/**
 * The desktop reads the same event store the CLI reads.
 *
 * It used to carry its own copy of the file layout, the JSONL parsing and the
 * hash-chain check, and its `read` verified the chain and threw while the
 * CLI's did not. Two entry points therefore had two failure vocabularies for
 * one corrupt stream: the desktop's list dropped the run silently while the
 * CLI reported a state derived from the tampered event.
 *
 * Verification now belongs to the application layer, which checks the chain
 * before anything replays it and keeps only the prefix the chain vouches
 * for. This adapter supplies bytes; it does not interpret them.
 */
export function createRunEventQueryAdapter(root?: string): RunEventQueryPort {
  return new JsonlEventStore({ root });
}
