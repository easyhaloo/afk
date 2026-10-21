import { describe, expect, it } from "vitest";
import { resolveWorkflowRequest } from "@afk/execution/application/workflows/run-request";
import { tmuxSessionNameFor } from "@afk/execution/domain/tmux/session-name";

/**
 * The session a work item runs in is named by the runtime and recognised
 * by the desktop. Both used to spell the name out, and the runtime
 * spelled it with two different work item identities - the canonical one
 * where it had it and the tracker's number where it did not. A desktop
 * that does not recognise the session of a run it started shows the run
 * as belonging to nothing.
 *
 * This test asks the runtime what it would name the session for a work
 * item it knows by two identities, and then asks the shared rule
 * whether that is the session for that work item.
 */
describe("the session a work item runs in", () => {
  it("is named after the work item's canonical identity", () => {
    const request = resolveWorkflowRequest({
      backlogId: "42",
      workItemId: "github:acme/api#42",
      projectName: "acme/api",
    } as never);

    // The tracker's number and the canonical identity are two names for
    // the same work item. The session carries the canonical one, because
    // that is the name the desktop recognises it by.
    expect(request.session).toBe(tmuxSessionNameFor("github:acme/api#42"));
    expect(request.session).not.toBe("afk-42");
  });

  it('is the same name whoever derives it', () => {
    expect(tmuxSessionNameFor("github:acme/api#42")).toBe("afk-github:acme/api#42");
    expect(tmuxSessionNameFor("github:acme/api#42")).toBe(tmuxSessionNameFor("github:acme/api#42"));
  });
});
