import { describe, expect, it } from "vitest";
import type { SshSession } from "../shared/ssh-contract";
import {
  applySshSessionEvents,
  createEarlySshSessionBuffer,
} from "../src/features/terminal/ssh-session-buffer";

function sshSession(state: SshSession["state"] = "open"): SshSession {
  return { id: "session-1", hostId: "host-1", alias: "server", kind: "ssh", title: "SSH", state };
}

describe("early SSH session buffer", () => {
  it("merges data and exit received before session registration in order", () => {
    const buffer = createEarlySshSessionBuffer();
    buffer.pushData("session-1", "banner\r\n");
    buffer.pushData("session-1", "password: ");
    buffer.pushExit("session-1", 23);

    const terminal = applySshSessionEvents(
      { open: true, pane: "", mode: "ssh", sshSession: sshSession() },
      "session-1",
      buffer.open("session-1"),
    );

    expect(terminal.pane).toBe("banner\r\npassword: \n\n[SSH 会话已退出，退出码 23]");
    expect(terminal.sshSession?.state).toBe("closed");
    expect(buffer.open("session-1")).toEqual([]);
  });

  it("appends events normally for an already registered session", () => {
    const terminal = applySshSessionEvents(
      { open: true, pane: "existing", mode: "ssh", sshSession: sshSession() },
      "session-1",
      [{ type: "data", data: " output" }],
    );

    expect(terminal.pane).toBe("existing output");
    expect(terminal.sshSession?.state).toBe("open");
  });

  it("does not apply events to a different session", () => {
    const current = { open: true, pane: "current", mode: "ssh" as const, sshSession: sshSession() };

    expect(applySshSessionEvents(current, "unknown-session", [{ type: "data", data: "ignored" }])).toBe(current);
  });

  it("bounds cached output and session count, and supports explicit cleanup", () => {
    const buffer = createEarlySshSessionBuffer({ maxSessions: 2, maxOutputCharsPerSession: 5 });
    buffer.pushData("oldest", "123456789");
    buffer.pushData("second", "abc");
    buffer.pushData("newest", "xyz");

    expect(buffer.open("oldest")).toEqual([]);
    expect(buffer.open("second")).toEqual([{ type: "data", data: "abc" }]);
    expect(buffer.open("newest")).toEqual([{ type: "data", data: "xyz" }]);

    buffer.pushData("limited", "123456789");
    expect(buffer.open("limited")).toEqual([{ type: "data", data: "12345" }]);

    buffer.pushExit("cleanup", 0);
    buffer.clear("cleanup");
    expect(buffer.open("cleanup")).toEqual([]);
    buffer.pushData("cleanup-all", "data");
    buffer.clearAll();
    expect(buffer.open("cleanup-all")).toEqual([]);

    const eventLimited = createEarlySshSessionBuffer({ maxEventsPerSession: 1 });
    eventLimited.pushExit("event-limited", 1);
    eventLimited.pushData("event-limited", "ignored");
    expect(eventLimited.open("event-limited")).toEqual([{ type: "exit", code: 1 }]);
  });

  it("drops late data and exit after close without affecting other sessions", () => {
    const buffer = createEarlySshSessionBuffer();
    buffer.pushData("closed-session", "before close");
    buffer.close("closed-session");
    buffer.pushData("closed-session", "late data");
    buffer.pushExit("closed-session", 9);
    buffer.pushData("other-session", "other data");

    expect(buffer.open("closed-session")).toEqual([]);
    expect(buffer.open("other-session")).toEqual([{ type: "data", data: "other data" }]);

    buffer.pushData("closed-session", "new lifecycle");
    expect(buffer.open("closed-session")).toEqual([{ type: "data", data: "new lifecycle" }]);
  });

  it("bounds closed-session tombstones and clears them on full cleanup", () => {
    const buffer = createEarlySshSessionBuffer({ maxClosedSessions: 2 });
    buffer.close("oldest-closed");
    buffer.close("second-closed");
    buffer.close("newest-closed");

    buffer.pushData("oldest-closed", "accepted after eviction");
    buffer.pushData("second-closed", "ignored");
    buffer.pushExit("newest-closed", 1);
    expect(buffer.open("oldest-closed")).toEqual([{ type: "data", data: "accepted after eviction" }]);
    expect(buffer.open("second-closed")).toEqual([]);
    expect(buffer.open("newest-closed")).toEqual([]);

    buffer.close("cleanup-closed");
    buffer.clearAll();
    buffer.pushData("cleanup-closed", "accepted after clearAll");
    expect(buffer.open("cleanup-closed")).toEqual([{ type: "data", data: "accepted after clearAll" }]);
  });
});
