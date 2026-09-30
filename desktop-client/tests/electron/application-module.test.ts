import { describe, expect, it } from "vitest";
import { loadApplication } from "../../electron/adapters/application-module";

describe("packaged application module", () => {
  it("loads inventory and history use cases from one local bundle", () => {
    const application = loadApplication();
    expect(application.queryProviderInventory).toBeTypeOf("function");
    expect(application.queryExecutionHistory).toBeTypeOf("function");
  });
});
