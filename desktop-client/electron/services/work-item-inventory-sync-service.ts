export type WorkItemInventorySyncService = {
  start: () => void;
  stop: () => void;
};

export type WorkItemInventorySyncServiceDeps = {
  sync: () => Promise<unknown>;
  intervalMs?: number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
};

export const WORK_ITEM_INVENTORY_SYNC_INTERVAL_MS = 5 * 60 * 1000;

export function createWorkItemInventorySyncService(deps: WorkItemInventorySyncServiceDeps): WorkItemInventorySyncService {
  const schedule = deps.setInterval ?? globalThis.setInterval;
  const cancel = deps.clearInterval ?? globalThis.clearInterval;
  const intervalMs = deps.intervalMs ?? WORK_ITEM_INVENTORY_SYNC_INTERVAL_MS;
  let timer: ReturnType<typeof globalThis.setInterval> | undefined;
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await deps.sync();
    } catch {
      return;
    } finally {
      running = false;
    }
  };

  return {
    start() {
      if (timer) return;
      void run();
      timer = schedule(() => { void run(); }, intervalMs);
    },
    stop() {
      if (!timer) return;
      cancel(timer);
      timer = undefined;
    },
  };
}
