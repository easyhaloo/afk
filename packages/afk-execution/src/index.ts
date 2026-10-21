/**
 * `@afk/execution` — the work item execution runtime.
 *
 * It owns the orchestration that implements, verifies and publishes a
 * managed work item, together with the agent runtime, sandbox, tmux and
 * git implementations that orchestration drives. The CLI and the desktop
 * client both depend on this package, so a work item runs through exactly
 * the same code whichever entry point asked for it.
 */
export {
  executeWorkItem,
  reconcileWorkItemMerge,
  isSuccessfulExecuteWorkItemStatus,
  EXECUTE_WORK_ITEM_SUCCESS_STATUSES,
  type ExecuteWorkItemStatus,
} from './application/workflows/execute-work-item.js';
export { LoopRunner } from './application/modules/loop-runner.js';
export { WorkflowRunner } from './application/workflow-engine.js';
export { generateWorkflowGraph, WORKFLOW_GRAPH_FORMATS } from './application/visualizations/workflow-graph.js';
export { writeGraphCache } from './application/visualizations/graph-cache.js';
