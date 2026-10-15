import { describe, expect, it } from "vitest";
import { createTmuxAttachPtyAdapter } from "../../electron/adapters/tmux-pty-adapter.js";

describe("tmux attach pty", () => {
  it("attaches to the exact target and detaches only the PTY client", () => {
    let dataListener: ((data: string) => void) | undefined;
    let exitListener: ((event: { exitCode: number }) => void) | undefined;
    let killed = false;
    const writes: string[] = [];
    const adapter = createTmuxAttachPtyAdapter({
      spawn: (file, args) => {
        expect(file).toBe("tmux");
        expect(args).toEqual(["attach-session", "-t", "afk-run:1.%0"]);
        return {
          pid: 1,
          onData: listener => { dataListener = listener; return { dispose() {} }; },
          onExit: listener => { exitListener = listener; return { dispose() {} }; },
          write: data => writes.push(data),
          resize: (cols, rows) => writes.push(`${cols}x${rows}`),
          kill: () => { killed = true; },
        };
      },
    });

    const attachId = adapter.attach("afk-run:1.%0", 80, 24);
    dataListener?.("ready");
    expect(adapter.input(attachId, "hello")).toBe(true);
    expect(adapter.resize(attachId, 100, 30)).toBe(true);
    expect(writes).toEqual(["hello", "100x30"]);
    expect(adapter.detach(attachId)).toBe(true);
    expect(killed).toBe(true);
    exitListener?.({ exitCode: 0 });
  });
});
