import { app } from "electron";
import { registerBacklogHandlers } from "./handlers/backlog.js";
import { registerGraphHandlers } from "./handlers/graph.js";
import { registerSshHandlers } from "./handlers/ssh.js";
import { registerTmuxHandlers } from "./handlers/tmux.js";
import { registerWorkItemHandlers } from "./handlers/work-items.js";
import { registerWorkspaceHandlers } from "./handlers/workspace.js";
import { defaultJumpserverService, workItemInventorySyncService, type JumpserverService } from "./ipc-services.js";

/**
 * The desktop's IPC entry.
 *
 * The services are assembled once, in `ipc-services.ts`; each domain
 * registers its own channels; the machinery that registers a channel —
 * a trusted sender, an input checked against a schema, the error the caller
 * sees — lives in `handler-registry.ts`. What is left here is the wiring.
 */
export function registerIpcHandlers(deps: { jumpserverService?: JumpserverService } = {}) {
  const jumpserverService = deps.jumpserverService ?? defaultJumpserverService;
  workItemInventorySyncService.start();
  if (typeof app.once === "function") app.once("before-quit", () => workItemInventorySyncService.stop());

  registerWorkspaceHandlers();
  registerWorkItemHandlers();
  registerTmuxHandlers();
  registerSshHandlers(jumpserverService);
  registerGraphHandlers();
  registerBacklogHandlers();
}
