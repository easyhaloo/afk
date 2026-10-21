import { describe, expect, it } from "vitest";
import { WORK_ITEM_AGENT_IDS } from "../../shared/backlog-contract.js";
import { AGENT_RUNTIME_DEFINITIONS } from "../../electron/services/runtime-service.js";

describe("the agents the desktop offers a work item to", () => {
  it("detects every agent the work item vocabulary names", () => {
    // The vocabulary says which agents a work item may be run with, and
    // the detector says which agents are installed. An agent in the
    // vocabulary with no definition is an agent the desktop offers and
    // then cannot find.
    const detected = AGENT_RUNTIME_DEFINITIONS.map(definition => definition.id);
    expect([...WORK_ITEM_AGENT_IDS].sort()).toEqual([...detected].sort());
  });

  it("names every agent the work item vocabulary names", () => {
    const detected = new Set(AGENT_RUNTIME_DEFINITIONS.map(definition => definition.id));
    for (const id of WORK_ITEM_AGENT_IDS) {
      expect(detected.has(id)).toBe(true);
    }
  });
});
