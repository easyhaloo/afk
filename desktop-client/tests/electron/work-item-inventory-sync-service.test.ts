import { describe, expect, it, vi } from "vitest";
import { createWorkItemInventorySyncService } from "../../electron/services/work-item-inventory-sync-service";

describe("work item inventory sync service", () => {
  it("runs an initial sync and prevents overlapping scheduled syncs", async () => {
    let resolveSync: (() => void) | undefined;
    const sync = vi.fn(() => new Promise<void>(resolve => { resolveSync = resolve; }));
    let scheduled: (() => void) | undefined;
    const service = createWorkItemInventorySyncService({
      sync,
      intervalMs: 1000,
      setInterval: vi.fn(callback => {
        scheduled = callback as () => void;
        return 1 as unknown as ReturnType<typeof globalThis.setInterval>;
      }),
      clearInterval: vi.fn(),
    });

    service.start();
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    scheduled?.();
    expect(sync).toHaveBeenCalledTimes(1);
    resolveSync?.();
    await new Promise<void>(resolve => setImmediate(resolve));
    scheduled?.();
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
    resolveSync?.();
    service.stop();
  });
});
