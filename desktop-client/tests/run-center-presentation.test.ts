import { describe, expect, it } from "vitest";
import { findRuntimeTerminalSession, groupRuntimeEvents, parseRuntimeSource, runtimeStateMeta, runtimeWorkspacePath } from "../src/features/run-center/runtime-presentation";

describe("groupRuntimeEvents", () => {
  it("shows one source once, newest run first, with its history retained", () => {
    const events = [
      { id: "old", source: "github:easyhaloo/afk#144", timestamp: "2026-09-24T08:00:00Z" },
      { id: "other", source: "gitlab:team/app#7", timestamp: "2026-09-24T10:00:00Z" },
      { id: "latest", source: "github:easyhaloo/afk#144", timestamp: "2026-09-24T11:00:00Z" },
    ];
    expect(groupRuntimeEvents(events)).toEqual([
      { source: "github:easyhaloo/afk#144", events: [events[2], events[0]] },
      { source: "gitlab:team/app#7", events: [events[1]] },
    ]);
    expect(events.map((event) => event.id)).toEqual(["old", "other", "latest"]);
  });
});

describe("run center presentation", () => {
  it("parses GitHub work item sources into provider, repository, and issue", () => {
    expect(parseRuntimeSource("github:easyhaloo/afk #144")).toEqual({
      provider: "github",
      repository: "easyhaloo/afk",
      workItem: "#144",
    });
  });

  it("parses compact provider sources without a space before the work item", () => {
    expect(parseRuntimeSource("github:easyhaloo/afk#144")).toEqual({
      provider: "github",
      repository: "easyhaloo/afk",
      workItem: "#144",
    });
  });

  it("parses GitLab work item sources into provider, repository, and issue", () => {
    expect(parseRuntimeSource("gitlab:platform/runner #139")).toEqual({
      provider: "gitlab",
      repository: "platform/runner",
      workItem: "#139",
    });
  });

  it("keeps unknown source strings readable without inventing a provider", () => {
    expect(parseRuntimeSource("local-backlog #12")).toEqual({
      provider: undefined,
      repository: "local-backlog",
      workItem: "#12",
    });
  });

  it("provides accessible visual semantics for every runtime phase", () => {
    expect(runtimeStateMeta("active")).toMatchObject({ icon: "active", ariaLabel: "执行中" });
    expect(runtimeStateMeta("ready")).toMatchObject({ icon: "ready", ariaLabel: "待执行" });
    expect(runtimeStateMeta("verify")).toMatchObject({ icon: "verify", ariaLabel: "已完成" });
    expect(runtimeStateMeta("attention")).toMatchObject({ icon: "attention", ariaLabel: "待处理" });
    expect(runtimeStateMeta("failed")).toMatchObject({ icon: "failed", ariaLabel: "失败" });
  });

  it("recognizes task workspace metadata without hiding actionable next steps", () => {
    expect(runtimeWorkspacePath("任务空间：/tmp/afk/144")).toBe("/tmp/afk/144");
    expect(runtimeWorkspacePath("等待负责人确认")).toBeNull();
  });

  it("matches a terminal session to the selected run workspace before using the fallback", () => {
    const sessions = [
      { name: "project", workspace: "/tmp/afk" },
      { name: "task-144", workspace: "/tmp/afk/144/" },
    ];
    expect(findRuntimeTerminalSession("/tmp/afk/144", sessions, "/tmp/afk")).toEqual(sessions[1]);
    expect(findRuntimeTerminalSession(null, sessions, "/tmp/afk")).toEqual(sessions[0]);
    expect(findRuntimeTerminalSession("/tmp/missing", sessions, "/tmp/other")).toBeNull();
    expect(findRuntimeTerminalSession("/tmp/missing", sessions, "/tmp/afk")).toBeNull();
  });
});
