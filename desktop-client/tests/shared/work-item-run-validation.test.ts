import { describe, expect, it } from "vitest";
import type { WorkItemRepositoryRef } from "../../shared/backlog-contract";
import {
  defaultBaseBranch,
  planRepositoryCheckoutPaths,
  repositorySelectionKey,
  validateBaseBranch,
  validateCheckoutPath,
  validateRunRepositorySelection,
  validateRunRepositorySelectionSet,
} from "../../shared/work-item-run-validation";

describe("work item run repository validation", () => {
  it("accepts valid Git branch names and reports the optional label", () => {
    expect(validateBaseBranch("main")).toBe("main");
    expect(validateBaseBranch("release/2026.09")).toBe("release/2026.09");
    expect(() => validateBaseBranch("bad..branch", "workingBranch")).toThrow(/workingBranch/i);
  });

  it.each([
    "",
    ".hidden",
    "feature.",
    "feature/.",
    "feature/.hidden",
    "feature.lock",
    "feature/topic.lock",
    "feature@{1}",
    "feature//topic",
    "feature\\topic",
    "feature topic",
    "feature~1",
    "feature^2",
    "feature:topic",
    "feature?topic",
    "feature*topic",
    "feature[topic",
    "feature\u0001topic",
  ])("rejects invalid Git branch name %j", (branch) => {
    expect(() => validateBaseBranch(branch)).toThrow(/baseBranch/i);
  });

  it("accepts safe relative checkout paths and rejects absolute or traversing paths", () => {
    expect(validateCheckoutPath("repositories/api")).toBe("repositories/api");
    expect(validateCheckoutPath("services/checkout-api")).toBe("services/checkout-api");
    for (const checkoutPath of [
      "",
      "/tmp/api",
      "C:tmp",
      "C:\\tmp\\api",
      "../api",
      "repositories/../api",
      "repositories\\..\\api",
      "repositories/api.",
      "repositories/api /child",
      "repositories/api:stream",
      "repositories/a?b",
      "repositories/a*b",
      "repositories/a|b",
      "repositories/a<b",
      "repositories/CON",
      "repositories/prn.txt",
      "repositories/Com1.log",
      "repositories/lpt9",
      "repositories/api/",
      "repositories\\api\\",
      "repositories/\u0000api",
      "repositories/\napi",
      "repositories/\tapi",
      "repositories/\u007fapi",
    ]) {
      expect(() => validateCheckoutPath(checkoutPath)).toThrow(/checkoutPath/i);
    }
    expect(() => validateCheckoutPath("C:tmp", "custom.checkoutPath")).toThrow(/custom\.checkoutPath/);
  });

  it("plans unique repository checkout paths with case-insensitive collision handling", () => {
    expect(planRepositoryCheckoutPaths([
      { name: "Repo", projectKey: "acme/repo-upper" },
      { name: "repo", projectKey: "acme/repo-lower" },
      { name: "shared repo", projectKey: "acme/shared-space" },
      { name: "shared/repo", projectKey: "acme/shared-slash" },
      { name: "custom", projectKey: "acme/custom", checkoutPath: "repositories/custom-checkout" },
    ])).toEqual([
      "repositories/Repo",
      "repositories/repo-2",
      "repositories/shared-repo",
      "repositories/shared-repo-2",
      "repositories/custom-checkout",
    ]);
  });

  it("falls back from invalid or conflicting explicit checkout paths", () => {
    expect(planRepositoryCheckoutPaths([
      { name: "api", projectKey: "acme/api", checkoutPath: "repositories/API" },
      { name: "web", projectKey: "acme/web", checkoutPath: "repositories/api" },
      { name: "worker", projectKey: "acme/worker", checkoutPath: "../worker" },
    ])).toEqual([
      "repositories/API",
      "repositories/web",
      "repositories/worker",
    ]);
  });

  it("validates a non-empty repository selection set with per-repository branches", () => {
    const selections = validateRunRepositorySelectionSet([
      { platform: "github", projectKey: "acme/api", providerProjectId: "101", name: "api", role: "primary", baseBranch: "main", checkoutPath: "repositories/api" },
      { platform: "gitlab", projectKey: "acme/web", name: "web", baseBranch: "develop", checkoutPath: "repositories/web" },
    ]);
    expect(selections).toEqual([
      { platform: "github", projectKey: "acme/api", providerProjectId: "101", name: "api", role: "primary", baseBranch: "main", checkoutPath: "repositories/api" },
      { platform: "gitlab", projectKey: "acme/web", name: "web", baseBranch: "develop", checkoutPath: "repositories/web" },
    ]);
    expect(repositorySelectionKey(selections[0])).toBe("github:acme/api");
    expect(repositorySelectionKey(selections[1])).toBe("gitlab:acme/web");
  });

  it("rejects empty, malformed, and duplicate repository selection sets", () => {
    expect(() => validateRunRepositorySelectionSet([])).toThrow(/repositories/i);
    expect(() => validateRunRepositorySelectionSet([
      { platform: "github", projectKey: "acme/api", name: "api", baseBranch: "main", checkoutPath: "repositories/api", webUrl: "https://example.test" },
    ])).toThrow(/unknown/i);
    expect(() => validateRunRepositorySelectionSet([
      { platform: "github", projectKey: "acme/api", name: "api", baseBranch: "main", checkoutPath: "repositories/api" },
      { platform: "github", projectKey: "acme/api", name: "api-copy", baseBranch: "develop", checkoutPath: "repositories/api-copy" },
    ])).toThrow(/duplicate/i);
    expect(() => validateRunRepositorySelectionSet([
      { platform: "github", projectKey: "acme/api", name: "api", baseBranch: "main", checkoutPath: "repositories/api" },
      { platform: "gitlab", projectKey: "acme/web", name: "web", baseBranch: "develop", checkoutPath: "repositories/api" },
    ])).toThrow(/duplicate.*checkoutPath/i);
    expect(() => validateRunRepositorySelectionSet([
      { platform: "github", projectKey: "acme/api", name: "api", baseBranch: "main", checkoutPath: "repositories/api" },
      { platform: "gitlab", projectKey: "acme/web", name: "web", baseBranch: "develop", checkoutPath: "repositories\\\\api" },
    ])).toThrow(/duplicate.*checkoutPath/i);
    expect(() => validateRunRepositorySelectionSet([
      { platform: "github", projectKey: "acme/api", name: "api", baseBranch: "main", checkoutPath: "repositories/api" },
      { platform: "gitlab", projectKey: "acme/web", name: "web", baseBranch: "develop", checkoutPath: "Repositories\\\\API" },
    ])).toThrow(/duplicate.*checkoutPath/i);
    expect(() => validateRunRepositorySelectionSet([
      { platform: "github", projectKey: "acme/api", name: "api", baseBranch: "main", checkoutPath: "repositories/api" },
      { platform: "gitlab", projectKey: "acme/web", name: "web", baseBranch: "develop", checkoutPath: "repositories/api/" },
    ])).toThrow(/checkoutPath/i);
    expect(() => validateRunRepositorySelectionSet([
      { platform: "github", projectKey: "acme/api", name: "api", baseBranch: "main", checkoutPath: "repositories/api" },
      { platform: "gitlab", projectKey: "acme/web", name: "web", baseBranch: "develop", checkoutPath: "repositories/CON" },
    ])).toThrow(/repositories\[1\]\.checkoutPath/);
    expect(() => validateRunRepositorySelectionSet([
      { platform: "github", projectKey: "acme/api", name: "api", baseBranch: "main", checkoutPath: "repositories/api" },
      { platform: "gitlab", projectKey: "acme/web", name: "web", baseBranch: "bad..branch", checkoutPath: "repositories/web" },
    ])).toThrow(/repositories\[1\]\.baseBranch/);
    expect(() => validateRunRepositorySelectionSet([
      { platform: "bitbucket", projectKey: "acme/api", name: "api", baseBranch: "main", checkoutPath: "repositories/api" },
    ])).toThrow(/platform/i);
  });

  it("checks repository association separately from structural parsing", () => {
    const associated: WorkItemRepositoryRef[] = [
      { id: "repo-api", platform: "github", projectKey: "acme/api", name: "api", defaultBranch: "main", checkoutPath: "repositories/api" },
    ];
    const selection = { platform: "github" as const, projectKey: "acme/api", name: "api", baseBranch: "release/1.0", checkoutPath: "repositories/api" };
    expect(validateRunRepositorySelection([selection], associated)).toEqual([selection]);
    expect(() => validateRunRepositorySelection(
      [{ platform: "gitlab", projectKey: "other/web", name: "web", baseBranch: "main", checkoutPath: "repositories/web" }],
      associated,
    )).toThrow(/associated|关联/i);
  });

  it("uses the repository default branch and falls back to main", () => {
    expect(defaultBaseBranch({ platform: "github", projectKey: "acme/api", name: "api", defaultBranch: "develop" })).toBe("develop");
    expect(defaultBaseBranch({ platform: "github", projectKey: "acme/api", name: "api" })).toBe("main");
    expect(() => defaultBaseBranch({ platform: "github", projectKey: "acme/api", name: "api", defaultBranch: "bad branch" })).toThrow(/defaultBranch/i);
  });
});
