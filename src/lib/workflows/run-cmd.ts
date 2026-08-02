/**
 * Shared CLI invocation of WorkflowRunner — used by both `afk workflow run`
 * (signal-driven workflow) and `afk issue run <iid> --project` (one-shot).
 *
 * Centralizes:
 *   - tracker construction (with --project forwarding)
 *   - session default (`afk-<iid>`)
 *   - cfg-default fallback for targetBranch / maxRetries / hardTimeoutMs
 *   - success / warning / process.exit semantics
 */
import { WorkflowRunner } from '../workflows';
import { createTrackerClient } from '../client-factory';
import { getWorkflowConfig } from '../core/config/manager';
import { success, warning, detail } from '../cli-utils';

export interface RunWorkflowCliOpts {
  iid: number;
  session?: string;
  projectName?: string;
  targetBranch?: string;
  baseBranch?: string;
  maxRetries?: number;
  hardTimeoutMs?: number;
  maxHandoffs?: number;
  contextHighTokens?: number;
  maxTotalTokens?: number;
  ext?: string[];
  extParams?: string[];
}

export async function runWorkflowCli(opts: RunWorkflowCliOpts): Promise<void> {
  const tracker = await createTrackerClient(opts.projectName);
  const runner = new WorkflowRunner(tracker);
  const cfg = getWorkflowConfig();
  const session = opts.session || `afk-${opts.iid}`;

  const result = await runner.run({
    iid: opts.iid,
    session,
    projectName: opts.projectName,
    targetBranch: opts.targetBranch ?? cfg.targetBranch,
    baseBranch: opts.baseBranch,
    maxRetries: opts.maxRetries ?? cfg.maxRetries,
    hardTimeoutMs: opts.hardTimeoutMs ?? cfg.completionTimeout,
    maxHandoffs: opts.maxHandoffs,
    contextHighTokens: opts.contextHighTokens,
    maxTotalTokens: opts.maxTotalTokens,
    ext: opts.ext,
    extParams: opts.extParams,
  });

  if (result.success) {
    success('Workflow completed!');
    if (result.url) detail(`MR: ${result.url}`);
    process.exit(0);
  }
  warning('Workflow did not complete successfully');
  process.exit(1);
}