import { describe, expect, it, vi } from "vitest";
import { StrictMode, createElement } from "react";
import { act, create } from "react-test-renderer";
import {
  SshTerminalView,
  createSshTerminalView,
  createSshTerminalRuntime,
  sshTerminalErrorMessage,
  type SshTerminalRuntimeOptions,
} from "../src/features/terminal/SshTerminalView";
import type { SshTerminalControllerOptions } from "../src/features/terminal/ssh-terminal-controller";

describe("SSH terminal view", () => {
  it("exports a React component function", () => {
    expect(SshTerminalView).toBeTypeOf("function");
  });

  it("builds and disposes the injected xterm lifecycle", () => {
    const host = {} as HTMLElement;
    const cleanupOrder: string[] = [];
    const addon = { fit: vi.fn(), dispose: vi.fn(() => cleanupOrder.push("addon")) };
    const terminal = {
      options: { disableStdin: false },
      loadAddon: vi.fn(),
      open: vi.fn(),
      focus: vi.fn(),
      dispose: vi.fn(() => cleanupOrder.push("terminal")),
      write: vi.fn(),
      hasSelection: vi.fn(() => false),
      getSelection: vi.fn(() => ""),
      onData: vi.fn(),
      onResize: vi.fn(),
      attachCustomKeyEventHandler: vi.fn(),
    };
    const controller = { syncOutput: vi.fn(), dispose: vi.fn() };
    const observer = { observe: vi.fn(), disconnect: vi.fn() };
    const createTerminal = vi.fn(() => terminal);
    const createController = vi.fn(() => controller);
    let resizeListener: (() => void) | undefined;
    const createResizeObserver = vi.fn((listener: () => void) => {
      resizeListener = listener;
      return observer;
    });
    const requestFrame = vi.fn((listener: FrameRequestCallback) => {
      requestFrame.listener = listener;
      return 17;
    });
    requestFrame.listener = undefined as FrameRequestCallback | undefined;
    const cancelFrame = vi.fn();
    let disabled = false;

    const runtime = createSshTerminalRuntime({
      host,
      platform: "other",
      disabled: () => disabled,
      callbacks: () => ({ onInput: vi.fn(), onResize: vi.fn(), onCopy: vi.fn(), onError: vi.fn() }),
      createTerminal,
      createFitAddon: () => addon,
      createController,
      createResizeObserver,
      requestFrame,
      cancelFrame,
    });

    const terminalOptions = createTerminal.mock.calls[0][0];
    const linkHandler = terminalOptions.linkHandler;
    expect(linkHandler).toEqual(expect.objectContaining({
      activate: expect.any(Function),
      hover: expect.any(Function),
      leave: expect.any(Function),
      allowNonHttpProtocols: false,
    }));
    const open = vi.fn();
    const confirm = vi.fn();
    vi.stubGlobal("open", open);
    vi.stubGlobal("confirm", confirm);
    linkHandler?.activate({} as MouseEvent, "https://example.com", {} as never);
    linkHandler?.hover?.({} as MouseEvent, "https://example.com", {} as never);
    linkHandler?.leave?.({} as MouseEvent, "https://example.com", {} as never);
    expect(open).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    expect(terminal.loadAddon).toHaveBeenCalledWith(addon);
    expect(terminal.open).toHaveBeenCalledWith(host);
    expect(observer.observe).toHaveBeenCalledWith(host);
    expect(addon.fit).not.toHaveBeenCalled();
    expect(terminal.focus).not.toHaveBeenCalled();

    resizeListener?.();
    expect(addon.fit).toHaveBeenCalledTimes(1);

    requestFrame.listener?.(0);
    expect(addon.fit).toHaveBeenCalledTimes(2);
    expect(terminal.focus).toHaveBeenCalledTimes(1);

    runtime.syncOutput("remote output");
    expect(controller.syncOutput).toHaveBeenCalledWith("remote output");

    disabled = true;
    runtime.setDisabled(true);
    expect(terminal.options.disableStdin).toBe(true);

    runtime.dispose();
    expect(cancelFrame).toHaveBeenCalledWith(17);
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
    expect(controller.dispose).toHaveBeenCalledTimes(1);
    expect(addon.dispose).toHaveBeenCalledTimes(1);
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
    expect(cleanupOrder).toEqual(["addon", "terminal"]);
  });

  it("classifies copy errors separately without exposing raw details", async () => {
    const copyFailure = new Error("secret clipboard details");
    const inputFailure = new Error("secret transport details");
    const resizeFailure = new Error("secret resize details");
    const terminalFailure = new Error("secret terminal details");
    const onError = vi.fn();
    let controllerOptions: SshTerminalControllerOptions | undefined;
    const terminal = {
      options: { disableStdin: false },
      loadAddon: vi.fn(),
      open: vi.fn(),
      focus: vi.fn(),
      dispose: vi.fn(),
    };
    const runtime = createSshTerminalRuntime({
      host: {} as HTMLElement,
      platform: "other",
      disabled: () => false,
      callbacks: () => ({
        onInput: vi.fn().mockRejectedValue(inputFailure),
        onResize: vi.fn().mockRejectedValue(resizeFailure),
        onCopy: vi.fn().mockRejectedValue(copyFailure),
        onError,
      }),
      createTerminal: vi.fn(() => terminal),
      createFitAddon: () => ({ fit: vi.fn(), dispose: vi.fn() }),
      createController: vi.fn((options) => {
        controllerOptions = options;
        return { syncOutput: vi.fn(), dispose: vi.fn() };
      }),
      createResizeObserver: () => ({ observe: vi.fn(), disconnect: vi.fn() }),
      requestFrame: () => 1,
      cancelFrame: vi.fn(),
    });

    const capturedControllerOptions = controllerOptions;
    if (!capturedControllerOptions) throw new Error("controller options were not captured");
    for (const operation of ["copy", "input", "resize"] as const) {
      try {
        if (operation === "copy") await capturedControllerOptions.copy("selected text");
        else if (operation === "input") await capturedControllerOptions.input("typed text");
        else await capturedControllerOptions.resize(100, 30);
      } catch (error) {
        capturedControllerOptions.reportError(error);
      }
    }
    capturedControllerOptions.reportError(terminalFailure);

    expect(onError).toHaveBeenNthCalledWith(1, "copy", copyFailure);
    expect(onError).toHaveBeenNthCalledWith(2, "input", inputFailure);
    expect(onError).toHaveBeenNthCalledWith(3, "resize", resizeFailure);
    expect(onError).toHaveBeenNthCalledWith(4, "terminal", terminalFailure);
    expect(sshTerminalErrorMessage("copy")).toBe("复制失败，请缩小选区或重试。");
    expect(sshTerminalErrorMessage("input")).toBe("终端操作失败，请重试；如果会话已经结束，请重新连接。");
    expect(sshTerminalErrorMessage("resize")).toBe("终端操作失败，请重试；如果会话已经结束，请重新连接。");
    expect(sshTerminalErrorMessage("terminal")).toBe("终端操作失败，请重试；如果会话已经结束，请重新连接。");
    expect(sshTerminalErrorMessage("copy")).not.toContain(copyFailure.message);
    expect(sshTerminalErrorMessage("input")).not.toContain(inputFailure.message);

    runtime.dispose();
  });

  it("keeps the real component lifecycle stable across StrictMode and rerenders", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const runtimes = Array.from({ length: 4 }, () => ({ syncOutput: vi.fn(), setDisabled: vi.fn(), dispose: vi.fn() }));
    const runtimeOptions: SshTerminalRuntimeOptions[] = [];
    const runtimeFactory = vi.fn((options: SshTerminalRuntimeOptions) => {
      runtimeOptions.push(options);
      return runtimes[runtimeOptions.length - 1];
    });
    const TestView = createSshTerminalView(runtimeFactory);
    const host = {} as HTMLElement;
    const firstInput = vi.fn();
    const latestInput = vi.fn();
    const commonProps = { onResize: vi.fn(), onCopy: vi.fn(), onError: vi.fn() };
    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(createElement(StrictMode, null,
        createElement(TestView, { sessionId: "session-a", output: "first", disabled: false, onInput: firstInput, ...commonProps }),
      ), {
        createNodeMock: (element) => element.props.className === "ssh-terminal-host" ? host : {},
      });
    });

    expect(runtimeFactory).toHaveBeenCalledTimes(2);
    expect(runtimes[0].dispose).toHaveBeenCalledTimes(1);
    expect(runtimes[1].syncOutput).toHaveBeenCalledWith("first");
    expect(renderer!.root.findByProps({ className: "ssh-terminal-shell" })).toBeDefined();
    expect(renderer!.root.findByProps({ className: "ssh-terminal-host" })).toBeDefined();

    await act(async () => {
      renderer!.update(createElement(StrictMode, null,
        createElement(TestView, { sessionId: "session-a", output: "second", disabled: true, onInput: latestInput, ...commonProps }),
      ));
    });

    expect(runtimeFactory).toHaveBeenCalledTimes(2);
    expect(runtimes[1].syncOutput).toHaveBeenCalledWith("second");
    expect(runtimes[1].setDisabled).toHaveBeenCalledWith(true);
    expect(runtimeOptions[1].callbacks().onInput).toBe(latestInput);

    await act(async () => {
      renderer!.update(createElement(StrictMode, null,
        createElement(TestView, { sessionId: "session-b", output: "new session", disabled: false, onInput: latestInput, ...commonProps }),
      ));
    });

    expect(runtimeFactory).toHaveBeenCalledTimes(3);
    expect(runtimes[1].dispose).toHaveBeenCalledTimes(1);
    expect(runtimes[2].syncOutput).toHaveBeenCalledWith("new session");

    await act(async () => renderer!.unmount());
    expect(runtimes[2].dispose).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
