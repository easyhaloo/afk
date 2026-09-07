import { describe, expect, it } from "vitest";
import { backlogStateLabel, filterBacklogItems } from "../src/features/backlog/backlog-filter";
import type { BacklogItem } from "../shared/backlog-contract";

const items: BacklogItem[] = [
  { id: "1", title: "登录态切换", dependsOn: [], state: "ready", executionMode: "afk", tags: ["billing"], branchName: "afk/backlog-1", providerRef: "stub:1" },
  { id: "2", title: "kg 演示", dependsOn: ["1"], state: "in_progress", executionMode: "afk", tags: ["urgent"], branchName: "afk/backlog-2", providerRef: "stub:2" },
  { id: "3", title: "支付回调", dependsOn: [], state: "done", executionMode: "hitl", tags: [], branchName: "afk/backlog-3", providerRef: "stub:3" },
];

describe("Backlog page filter", () => {
  it("returns the original list when query and state filters are unset", () => {
    expect(filterBacklogItems(items, "", "all")).toEqual(items);
  });

  it("filters by title (case-insensitive)", () => {
    expect(filterBacklogItems(items, "kg", "all")).toEqual([items[1]]);
  });

  it("filters by tag", () => {
    expect(filterBacklogItems(items, "urgent", "all")).toEqual([items[1]]);
  });

  it("filters by state", () => {
    expect(filterBacklogItems(items, "", "in_progress")).toEqual([items[1]]);
    expect(filterBacklogItems(items, "", "done")).toEqual([items[2]]);
  });

  it("combines query and state filters", () => {
    expect(filterBacklogItems(items, "kg", "ready")).toEqual([]);
    expect(filterBacklogItems(items, "kg", "in_progress")).toEqual([items[1]]);
  });

  it("does not mutate the input array", () => {
    const snapshot = [...items];
    filterBacklogItems(items, "x", "all");
    expect(items).toEqual(snapshot);
  });

  it("treats whitespace-only queries as no query", () => {
    expect(filterBacklogItems(items, "   ", "all")).toEqual(items);
  });

  it("matches queries case-insensitively for title and tags", () => {
    expect(filterBacklogItems(items, "KG", "all")).toEqual([items[1]]);
    expect(filterBacklogItems(items, "URGENT", "all")).toEqual([items[1]]);
    expect(filterBacklogItems(items, "BILLING", "all")).toEqual([items[0]]);
  });

  it("returns an empty array when the input is empty regardless of state", () => {
    expect(filterBacklogItems([], "anything", "all")).toEqual([]);
    expect(filterBacklogItems([], "anything", "in_progress")).toEqual([]);
  });

  it("matches the id field in the search", () => {
    expect(filterBacklogItems(items, "1", "all")).toEqual([items[0]]);
    expect(filterBacklogItems(items, "3", "all")).toEqual([items[2]]);
  });
});

describe("Backlog page state labels", () => {
  it("returns human-readable labels for each state", () => {
    expect(backlogStateLabel("ready")).toBe("待处理");
    expect(backlogStateLabel("in_progress")).toBe("进行中");
    expect(backlogStateLabel("verification")).toBe("验证中");
    expect(backlogStateLabel("merge_ready")).toBe("待合并");
    expect(backlogStateLabel("done")).toBe("已完成");
    expect(backlogStateLabel("blocked")).toBe("阻塞");
    expect(backlogStateLabel("rework")).toBe("返工中");
  });
});
