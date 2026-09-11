import { describe, expect, it, vi } from "vitest";
import { createSshTerminalController } from "../src/features/terminal/ssh-terminal-controller";

type DataListener = (data: string) => void;
type ResizeListener = (size: { cols: number; rows: number }) => void;
type KeyListener = (event: KeyboardEvent) => boolean;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

class FakeTerminal {
  writes: string[] = [];
  writeFailures: unknown[] = [];
  dataDisposeCount = 0;
  resizeDisposeCount = 0;
  selection = "";
  private dataListener: DataListener | null = null;
  private resizeListener: ResizeListener | null = null;
  private keyListener: KeyListener | null = null;

  write(data: string) {
    const failure = this.writeFailures.shift();
    if (failure) {
      throw failure;
    }

    this.writes.push(data);
  }

  failNextWrite(error: unknown) {
    this.writeFailures.push(error);
  }

  hasSelection() {
    return this.selection.length > 0;
  }

  getSelection() {
    return this.selection;
  }

  onData(listener: DataListener) {
    this.dataListener = listener;
    return {
      dispose: () => {
        this.dataDisposeCount += 1;
      },
    };
  }

  onResize(listener: ResizeListener) {
    this.resizeListener = listener;
    return {
      dispose: () => {
        this.resizeDisposeCount += 1;
      },
    };
  }

  attachCustomKeyEventHandler(listener: KeyListener) {
    this.keyListener = listener;
  }

  emitData(data: string) {
    this.dataListener?.(data);
  }

  emitResize(cols: number, rows: number) {
    this.resizeListener?.({ cols, rows });
  }

  emitKey(input: Partial<KeyboardEvent> & Pick<KeyboardEvent, "key">) {
    if (!this.keyListener) {
      throw new Error("custom key handler is not attached");
    }

    return this.keyListener({
      type: "keydown",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      ...input,
    } as KeyboardEvent);
  }
}

function createHarness(overrides: Partial<Parameters<typeof createSshTerminalController>[0]> = {}) {
  const terminal = new FakeTerminal();
  const input = vi.fn();
  const resize = vi.fn();
  const copy = vi.fn();
  const reportError = vi.fn();
  const controller = createSshTerminalController({
    terminal,
    platform: "other",
    input,
    resize,
    copy,
    reportError,
    ...overrides,
  });

  return { terminal, input, resize, copy, reportError, controller };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("SSH terminal controller", () => {
  it("forwards composed text as one unchanged input payload", () => {
    const { terminal, input } = createHarness();

    terminal.emitData("中文");

    expect(input).toHaveBeenCalledTimes(1);
    expect(input).toHaveBeenCalledWith("中文");
  });

  it("writes output increments and queues RIS before replaced, truncated, or cleared output", () => {
    const { terminal, controller } = createHarness();

    controller.syncOutput("");
    controller.syncOutput("hello");
    controller.syncOutput("hello world");
    controller.syncOutput("hello world");
    controller.syncOutput("hello");
    controller.syncOutput("new");
    controller.syncOutput("");

    expect(terminal.writes).toEqual([
      "hello",
      " world",
      "\u001bchello",
      "\u001bcnew",
      "\u001bc",
    ]);
  });

  it("reports an incremental write failure and retries the same full output", () => {
    const { terminal, reportError, controller } = createHarness();
    const failure = new Error("write failed");
    terminal.failNextWrite(failure);

    controller.syncOutput("hello");
    controller.syncOutput("hello");
    controller.syncOutput("hello world");

    expect(reportError).toHaveBeenCalledWith(failure);
    expect(terminal.writes).toEqual(["hello", " world"]);
  });

  it("advances replacement output state only after the RIS write succeeds", () => {
    const { terminal, reportError, controller } = createHarness();
    const failure = new Error("replacement failed");
    controller.syncOutput("old");
    terminal.failNextWrite(failure);

    controller.syncOutput("new");
    controller.syncOutput("new");
    controller.syncOutput("new output");

    expect(reportError).toHaveBeenCalledWith(failure);
    expect(terminal.writes).toEqual(["old", "\u001bcnew", " output"]);
  });

  it("copies the selected range without forwarding the key to xterm", async () => {
    const { terminal, copy, input } = createHarness();
    terminal.selection = "selected output";

    const forwarded = terminal.emitKey({ key: "c", ctrlKey: true });
    await flushPromises();

    expect(forwarded).toBe(false);
    expect(copy).toHaveBeenCalledWith("selected output");
    expect(input).not.toHaveBeenCalled();
  });

  it("ignores Ctrl+Shift+C without forwarding it to xterm", () => {
    const { terminal, copy, input } = createHarness();

    const forwarded = terminal.emitKey({ key: "c", ctrlKey: true, shiftKey: true });

    expect(forwarded).toBe(false);
    expect(copy).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
  });

  it.each(["keyup", "keypress"])("does not copy again during %s", async (type) => {
    const { terminal, copy } = createHarness();
    terminal.selection = "selected output";

    const forwarded = terminal.emitKey({ type, key: "c", ctrlKey: true });
    await flushPromises();

    expect(forwarded).toBe(true);
    expect(copy).not.toHaveBeenCalled();
  });

  it("leaves Ctrl+C under xterm control when there is no selection", () => {
    const { terminal } = createHarness();

    expect(terminal.emitKey({ key: "c", ctrlKey: true })).toBe(true);
  });

  it("leaves native paste and ordinary terminal keys under xterm control", () => {
    const { terminal } = createHarness();

    expect(terminal.emitKey({ key: "v", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(terminal.emitKey({ key: "a" })).toBe(true);
  });

  it("keeps one resize in flight and collapses A to B to A back to the active A", async () => {
    const activeResize = deferred<void>();
    const resize = vi.fn(() => activeResize.promise);
    const { terminal } = createHarness({ resize });

    terminal.emitResize(100, 30);
    terminal.emitResize(120, 40);
    terminal.emitResize(100, 30);

    expect(resize.mock.calls).toEqual([[100, 30]]);

    activeResize.resolve();
    await flushPromises();
    expect(resize.mock.calls).toEqual([[100, 30]]);
  });

  it("serially returns to applied A when B is pending and the desired size changes back to A", async () => {
    const applyA = deferred<void>();
    const applyB = deferred<void>();
    const returnToA = deferred<void>();
    const resize = vi
      .fn()
      .mockReturnValueOnce(applyA.promise)
      .mockReturnValueOnce(applyB.promise)
      .mockReturnValueOnce(returnToA.promise);
    const { terminal } = createHarness({ resize });

    terminal.emitResize(100, 30);
    applyA.resolve();
    await flushPromises();

    terminal.emitResize(120, 40);
    terminal.emitResize(100, 30);
    expect(resize.mock.calls).toEqual([
      [100, 30],
      [120, 40],
    ]);

    applyB.resolve();
    await flushPromises();
    expect(resize.mock.calls).toEqual([
      [100, 30],
      [120, 40],
      [100, 30],
    ]);

    returnToA.resolve();
    await flushPromises();
  });

  it.each([
    ["input", (terminal: FakeTerminal) => terminal.emitData("data")],
    [
      "copy",
      (terminal: FakeTerminal) => {
        terminal.selection = "selection";
        terminal.emitKey({ key: "c", ctrlKey: true });
      },
    ],
  ] as const)("reports asynchronous %s callback rejection", async (callbackName, invoke) => {
    const failure = new Error(`${callbackName} failed`);
    const callback = vi.fn().mockRejectedValue(failure);
    const { terminal, reportError } = createHarness({ [callbackName]: callback });

    invoke(terminal);
    await flushPromises();

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(failure);
  });

  it.each([
    ["input", (terminal: FakeTerminal) => terminal.emitData("data")],
    [
      "copy",
      (terminal: FakeTerminal) => {
        terminal.selection = "selection";
        terminal.emitKey({ key: "c", ctrlKey: true });
      },
    ],
  ] as const)("reports synchronous %s callback errors", (callbackName, invoke) => {
    const failure = new Error(`${callbackName} failed`);
    const callback = vi.fn(() => {
      throw failure;
    });
    const { terminal, reportError } = createHarness({ [callbackName]: callback });

    invoke(terminal);

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(failure);
  });

  it("does not report a callback rejection after disposal", async () => {
    const pendingInput = deferred<void>();
    const input = vi.fn(() => pendingInput.promise);
    const { terminal, reportError, controller } = createHarness({ input });

    terminal.emitData("pending");
    controller.dispose();
    pendingInput.reject(new Error("late failure"));
    await flushPromises();

    expect(reportError).not.toHaveBeenCalled();
  });

  it("deduplicates pending and applied sizes, then permits retry after failure", async () => {
    const firstResize = deferred<void>();
    const retryResize = deferred<void>();
    const failure = new Error("resize failed");
    const resize = vi
      .fn()
      .mockReturnValueOnce(firstResize.promise)
      .mockReturnValueOnce(retryResize.promise);
    const { terminal, reportError } = createHarness({ resize });

    terminal.emitResize(100, 30);
    terminal.emitResize(100, 30);
    expect(resize).toHaveBeenCalledTimes(1);

    firstResize.reject(failure);
    await flushPromises();
    expect(reportError).toHaveBeenCalledWith(failure);

    terminal.emitResize(100, 30);
    terminal.emitResize(100, 30);
    expect(resize).toHaveBeenCalledTimes(2);

    retryResize.resolve();
    await flushPromises();
    terminal.emitResize(100, 30);
    expect(resize).toHaveBeenCalledTimes(2);
  });

  it("continues with a newer desired size after an in-flight resize fails", async () => {
    const resizeA = deferred<void>();
    const resizeB = deferred<void>();
    const failure = new Error("A failed");
    const resize = vi
      .fn()
      .mockReturnValueOnce(resizeA.promise)
      .mockReturnValueOnce(resizeB.promise);
    const { terminal, reportError } = createHarness({ resize });

    terminal.emitResize(100, 30);
    terminal.emitResize(120, 40);
    expect(resize.mock.calls).toEqual([[100, 30]]);

    resizeA.reject(failure);
    await flushPromises();

    expect(reportError).toHaveBeenCalledWith(failure);
    expect(resize.mock.calls).toEqual([
      [100, 30],
      [120, 40],
    ]);

    resizeB.resolve();
    await flushPromises();
  });

  it("treats an undefined Promise rejection as a failed resize that can retry", async () => {
    const firstResize = deferred<void>();
    const resize = vi.fn().mockReturnValueOnce(firstResize.promise).mockResolvedValueOnce(undefined);
    const { terminal, reportError } = createHarness({ resize });

    terminal.emitResize(100, 30);
    firstResize.reject(undefined);
    await flushPromises();

    expect(reportError).toHaveBeenCalledWith(undefined);
    terminal.emitResize(100, 30);
    await flushPromises();
    expect(resize).toHaveBeenCalledTimes(2);
  });

  it("disposes subscriptions and prevents all later controller actions", async () => {
    const { terminal, input, resize, copy, controller } = createHarness();
    terminal.selection = "selection";

    controller.dispose();
    terminal.emitData("after dispose");
    terminal.emitResize(80, 24);
    expect(terminal.emitKey({ key: "c", ctrlKey: true })).toBe(true);
    controller.syncOutput("after dispose");
    await flushPromises();

    expect(terminal.dataDisposeCount).toBe(1);
    expect(terminal.resizeDisposeCount).toBe(1);
    expect(input).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
    expect(terminal.writes).toEqual([]);
  });
});
