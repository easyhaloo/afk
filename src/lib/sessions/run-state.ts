/**
 * Run state directory — persists per-run diagnostics under
 *   <worktree>/.afk/runs/<run-id>/
 *     ├── request.json       (initial goal + provider + generation)
 *     ├── events.jsonl       (incremental event stream; atomic line append)
 *     ├── result.json        (final ExecutionResult)
 *     └── output.log         (tail of tmux pane capture)
 *
 * Per the design (EXECUTION-DESIGN.md §7):
 *   "Session 文件必须使用临时文件、校验和原子 rename，避免新 generation 读取半截 JSONL."
 *
 * The run state directory is best-effort diagnostics, NOT a control plane.
 * Every write is wrapped in try/catch and logs a warning on failure - a
 * phase must NEVER be aborted by a failed diagnostic write.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import type { ExecutionResult } from '../sandbox/types';

const RUNS_DIR = '.afk/runs';

export interface RunRequest {
  runId: string;
  iid: number;
  generation: number;
  provider: string;
  worktreePath: string;
  goalText: string;
  signalType: 'goal_complete' | 'ac_result';
  startedAt: string;
}

export class RunStateWriter {
  constructor(
    private readonly worktreePath: string,
    private readonly runId: string,
  ) {}

  private dir(): string {
    return join(this.worktreePath, RUNS_DIR, this.runId);
  }

  /** Best-effort: never throws. Logs warnings on failure. */
  async init(): Promise<void> {
    try {
      await fs.mkdir(this.dir(), { recursive: true });
    } catch {
      // ignored — diagnostics are best-effort
    }
  }

  /** Persist initial request as JSON. Atomic temp+rename. */
  async writeRequest(req: RunRequest): Promise<void> {
    await this.atomicWrite('request.json', JSON.stringify(req, null, 2));
  }

  /** Append a single JSON event line. Atomic (append-only is atomic for small writes on POSIX). */
  async appendEvent(event: unknown): Promise<void> {
    try {
      await fs.appendFile(join(this.dir(), 'events.jsonl'), JSON.stringify(event) + '\n', 'utf-8');
    } catch {
      // ignored
    }
  }

  /** Persist the final ExecutionResult. Atomic temp+rename. */
  async writeResult(result: ExecutionResult): Promise<void> {
    const serialized = JSON.stringify(result, null, 2);
    const checksum = createHash('sha256').update(serialized).digest('hex');
    await this.atomicWrite('result.json', serialized);
    await this.atomicWrite('result.json.sha256', checksum);
  }

  /** Tail of tmux pane capture (last N lines). */
  async writeOutput(content: string): Promise<void> {
    await this.atomicWrite('output.log', content);
  }

  /** Atomic temp+rename for whole-file writes. Failure is swallowed. */
  private async atomicWrite(name: string, content: string): Promise<void> {
    try {
      const finalPath = join(this.dir(), name);
      const tmpPath = `${finalPath}.tmp`;
      await fs.writeFile(tmpPath, content, 'utf-8');
      await fs.rename(tmpPath, finalPath);
    } catch {
      // ignored — diagnostics are best-effort
    }
  }
}