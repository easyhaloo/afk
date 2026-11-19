import { describe, expect, it } from "vitest";
import { parseExperienceOutcomeQuery } from "../shared/experience-contract.js";

const input = { scope: "github:acme/api", runId: "consumer-run", workItemId: "github:acme/api#2" };

describe("experience outcome query contract", () => {
  it("requires a canonical same-project identity and defaults to twenty bounded receipts", () => {
    expect(parseExperienceOutcomeQuery(input)).toEqual({ ...input, limit: 20 });
    for (const limit of [0, 1, 100]) expect(parseExperienceOutcomeQuery({ ...input, limit }).limit).toBe(limit);
    expect(parseExperienceOutcomeQuery({ scope: "gitlab:team/service", runId: "run", workItemId: "gitlab:team/service#3" }).limit).toBe(20);
  });

  it.each([
    { runId: undefined }, { runId: " " }, { runId: "x\0" }, { runId: "x".repeat(513) },
    { workItemId: undefined }, { workItemId: "#2" }, { workItemId: "github:acme/api#02" },
    { workItemId: " github:acme/api#2" }, { workItemId: "github:acme/other#2" },
    { workItemId: "gitlab:acme/api#2" }, { scope: "../private" },
    { limit: -1 }, { limit: 101 }, { limit: 0.5 }, { limit: NaN }, { limit: Infinity },
    { limit: "20" }, { limit: null }, { limit: Number.MAX_SAFE_INTEGER + 1 }, { secret: "private" },
  ])("rejects invalid input %j", change => {
    expect(() => parseExperienceOutcomeQuery({ ...input, ...change })).toThrow();
  });
});
