import { describe, expect, it } from "vitest";
import { buildWorkItemRunArgs } from "../../electron/services/work-item-execution-service";

describe("single work-item execution CLI", () => {
  it("uses the orchestrated execution entry instead of implementation-only run", () => {
    expect(buildWorkItemRunArgs({ workItemId: "github:easyhaloo/afk#158", repositories: [], workflow: "default" }, "/tmp/manifest.json")).toEqual([
      "execute", "--work-item-id", "github:easyhaloo/afk#158", "--execution-manifest", "/tmp/manifest.json", "--template", "default",
    ]);
    expect(buildWorkItemRunArgs({ workItemId: "github:easyhaloo/afk#158", repositories: [] }, "/tmp/manifest.json", "desktop-123")).toEqual([
      "execute", "--work-item-id", "github:easyhaloo/afk#158", "--execution-manifest", "/tmp/manifest.json", "--execution-id", "desktop-123",
    ]);
  });
});
