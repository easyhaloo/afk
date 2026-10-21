import { describe, expect, it } from "vitest";
import { createDesktopService } from "../../electron/services/desktop-service.js";
import { stubConfigurationPort, stubResourceAdapter, stubWorkflowConfig } from "./port-stubs.js";

describe("desktop workflow configuration summary", () => {
  it("shows what the runner will use, read through the port", async () => {
    const asked: string[] = [];
    const service = createDesktopService({
      configuration: stubConfigurationPort({
        workflow: (root) => {
          asked.push(root);
          return stubWorkflowConfig({ agentDefault: "port-agent", maxRetries: 7, targetBranch: "port/target", goalBudget: 4242 });
        },
      }),
      resourceAdapter: stubResourceAdapter(),
    });

    const summary = await service.readWorkflowConfig("/tmp/afk-workspace");

    // The desktop asks the runner's reader for the configuration of the
    // workspace it is showing; it does not read the file itself, so the
    // page cannot show a configuration no run would use.
    expect(asked).toEqual(["/tmp/afk-workspace"]);
    expect(summary.agentDefault).toBe("port-agent");
    expect(summary.maxRetries).toBe(7);
    expect(summary.targetBranch).toBe("port/target");
    expect(summary.goalBudget).toBe(4242);
  });

  it("falls back to the defaults when the runner refuses the configuration", async () => {
    const service = createDesktopService({
      configuration: stubConfigurationPort({
        workflow: () => { throw new Error("配置文件无法解析"); },
        defaults: () => stubWorkflowConfig({ targetBranch: "defaults/target", maxRetries: 1 }),
      }),
      resourceAdapter: stubResourceAdapter(),
    });

    const summary = await service.readWorkflowConfig("/tmp/afk-workspace");

    // A configuration the runner refuses leaves the page on the defaults
    // rather than taking the whole overview down with it.
    expect(summary.targetBranch).toBe("defaults/target");
    expect(summary.maxRetries).toBe(1);
  });
});
