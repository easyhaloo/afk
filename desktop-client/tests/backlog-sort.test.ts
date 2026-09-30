import { describe, expect, it } from "vitest";
import type { BacklogItem } from "../../../shared/backlog-contract";
import { parseBacklogSort, sortBacklogItems } from "../src/features/backlog/backlog-sort";

function item(overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id: "1",
    title: "Task",
    dependsOn: [],
    state: "ready",
    executionMode: "afk",
    tags: [],
    branchName: "afk/backlog-1",
    providerRef: "stub:1",
    ...overrides,
  };
}

describe("parseBacklogSort", () => {
  it("defaults to id ascending for unknown or absent values", () => {
    expect(parseBacklogSort(undefined)).toEqual({ field: "id", direction: "asc" });
    expect(parseBacklogSort("bogus")).toEqual({ field: "id", direction: "asc" });
  });

  it("parses known option values", () => {
    expect(parseBacklogSort("state:desc")).toEqual({ field: "state", direction: "desc" });
    expect(parseBacklogSort("updatedAt:desc")).toEqual({ field: "updatedAt", direction: "desc" });
  });
});

describe("sortBacklogItems", () => {
  const items = [
    item({ id: "b", title: "Zeta", state: "done", updatedAt: "2026-01-01" }),
    item({ id: "a", title: "Alpha", state: "ready", updatedAt: "2026-03-01" }),
    item({ id: "c", title: "Mid", state: "in_progress", updatedAt: "2026-02-01" }),
  ];

  it("sorts by id ascending by default and never mutates input", () => {
    const sorted = sortBacklogItems(items, { field: "id", direction: "asc" });
    expect(sorted.map(entry => entry.id)).toEqual(["a", "b", "c"]);
    expect(items.map(entry => entry.id)).toEqual(["b", "a", "c"]);
  });

  it("sorts by title with direction", () => {
    expect(sortBacklogItems(items, { field: "title", direction: "desc" }).map(entry => entry.id)).toEqual(["b", "c", "a"]);
  });

  it("sorts by canonical state progression", () => {
    expect(sortBacklogItems(items, { field: "state", direction: "asc" }).map(entry => entry.id)).toEqual(["a", "c", "b"]);
    expect(sortBacklogItems(items, { field: "state", direction: "desc" }).map(entry => entry.id)).toEqual(["b", "c", "a"]);
  });

  it("orders updatedAt ascending with missing dates first and descending with them last", () => {
    const withMissing = [item({ id: "x", updatedAt: undefined }), item({ id: "d", updatedAt: "2026-01-01" })];
    expect(sortBacklogItems(withMissing, { field: "updatedAt", direction: "asc" }).map(entry => entry.id)).toEqual(["x", "d"]);
    expect(sortBacklogItems(withMissing, { field: "updatedAt", direction: "desc" }).map(entry => entry.id)).toEqual(["d", "x"]);
  });

  it("breaks ties deterministically by id", () => {
    const tied = [item({ id: "2", title: "Same" }), item({ id: "1", title: "Same" })];
    expect(sortBacklogItems(tied, { field: "title", direction: "asc" }).map(entry => entry.id)).toEqual(["1", "2"]);
  });
});
