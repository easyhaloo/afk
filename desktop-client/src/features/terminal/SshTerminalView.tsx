import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ILinkHandler, type ITerminalAddon, type ITerminalOptions } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import {
  createSshTerminalController,
  type SshTerminalControllerOptions,
  type SshTerminalPort,
} from "./ssh-terminal-controller";
import type { TerminalPlatform } from "./ssh-terminal-model";
import "./ssh-terminal.css";

type MaybePromise = Promise<unknown> | void;

export type SshTerminalOperation = "copy" | "input" | "resize" | "terminal";

export type SshTerminalViewProps = {
  sessionId: string;
  output: string;
  disabled: boolean;
  onInput(data: string): MaybePromise;
  onResize(cols: number, rows: number): MaybePromise;
  onCopy(data: string): MaybePromise;
  onError(operation: SshTerminalOperation, error: unknown): void;
};

type RuntimeCallbacks = Pick<SshTerminalViewProps, "onInput" | "onResize" | "onCopy" | "onError">;

type RuntimeFitAddon = ITerminalAddon & {
  fit(): void;
};

type RuntimeTerminal = SshTerminalPort & {
  options: ITerminalOptions;
  loadAddon(addon: ITerminalAddon): void;
  open(host: HTMLElement): void;
  focus(): void;
  dispose(): void;
};

type RuntimeController = {
  syncOutput(output: string): void;
  dispose(): void;
};

type RuntimeResizeObserver = {
  observe(host: HTMLElement): void;
  disconnect(): void;
};

export type SshTerminalRuntimeOptions = {
  host: HTMLElement;
  platform: TerminalPlatform;
  disabled(): boolean;
  callbacks(): RuntimeCallbacks;
  createTerminal(options: ITerminalOptions): RuntimeTerminal;
  createFitAddon(): RuntimeFitAddon;
  createController(options: SshTerminalControllerOptions): RuntimeController;
  createResizeObserver(listener: () => void): RuntimeResizeObserver;
  requestFrame(listener: FrameRequestCallback): number;
  cancelFrame(handle: number): void;
};

const operationErrorTag = Symbol("ssh-terminal-operation-error");
const blockedOscLinkHandler: ILinkHandler = {
  activate() {},
  hover() {},
  leave() {},
  allowNonHttpProtocols: false,
};

type OperationError = {
  [operationErrorTag]: true;
  operation: Exclude<SshTerminalOperation, "terminal">;
  error: unknown;
};

function isOperationError(error: unknown): error is OperationError {
  return typeof error === "object" && error !== null && operationErrorTag in error;
}

async function runOperation(operation: OperationError["operation"], callback: () => MaybePromise) {
  try {
    await callback();
  } catch (error) {
    throw { [operationErrorTag]: true, operation, error } satisfies OperationError;
  }
}

export function sshTerminalErrorMessage(operation: SshTerminalOperation) {
  if (operation === "copy") return "复制失败，请缩小选区或重试。";
  return "终端操作失败，请重试；如果会话已经结束，请重新连接。";
}

export function sshTerminalOptions(): ITerminalOptions {
  return {
    cursorBlink: true,
    convertEol: false,
    scrollback: 5000,
    fontFamily: '"SFMono-Regular", "SF Mono", "DM Mono", ui-monospace, monospace',
    fontSize: 11,
    linkHandler: blockedOscLinkHandler,
    theme: {
      background: "#1c1f24",
      foreground: "#d9dde5",
      cursor: "#b8c0cc",
      cursorAccent: "#1c1f24",
      selectionBackground: "#3b4657",
      black: "#202329",
      red: "#d57a7a",
      green: "#88b48f",
      yellow: "#c7a96b",
      blue: "#7897bd",
      magenta: "#a68ab8",
      cyan: "#75a9aa",
      white: "#c8ccd4",
      brightBlack: "#656b75",
      brightRed: "#e19191",
      brightGreen: "#9bc6a2",
      brightYellow: "#d9bb7e",
      brightBlue: "#8ba9cb",
      brightMagenta: "#b99ccb",
      brightCyan: "#89bdbd",
      brightWhite: "#eef0f4",
    },
  };
}

export function createSshTerminalRuntime(options: SshTerminalRuntimeOptions) {
  let active = true;
  let terminal: RuntimeTerminal | null = null;
  let fitAddon: RuntimeFitAddon | null = null;
  let controller: RuntimeController | null = null;
  let resizeObserver: RuntimeResizeObserver | null = null;
  let animationFrame: number | null = null;

  const reportError = (error: unknown) => {
    if (!active) return;
    if (isOperationError(error)) {
      options.callbacks().onError(error.operation, error.error);
      return;
    }
    options.callbacks().onError("terminal", error);
  };

  const dispose = () => {
    if (!active) return;
    active = false;
    if (animationFrame !== null) options.cancelFrame(animationFrame);
    resizeObserver?.disconnect();
    controller?.dispose();
    fitAddon?.dispose();
    terminal?.dispose();
  };

  try {
    terminal = options.createTerminal(sshTerminalOptions());
    const createdFitAddon = options.createFitAddon();
    fitAddon = createdFitAddon;
    terminal.loadAddon(createdFitAddon);
    terminal.options.disableStdin = options.disabled();
    terminal.open(options.host);
    controller = options.createController({
      terminal,
      platform: options.platform,
      input: (data) => runOperation("input", async () => {
        if (options.disabled()) return;
        await options.callbacks().onInput(data);
      }),
      resize: (cols, rows) => runOperation("resize", async () => {
        if (options.disabled()) return;
        await options.callbacks().onResize(cols, rows);
      }),
      copy: (data) => runOperation("copy", () => options.callbacks().onCopy(data)),
      reportError,
    });

    const fit = () => {
      if (!active) return;
      try {
        createdFitAddon.fit();
      } catch (error) {
        reportError(error);
      }
    };
    resizeObserver = options.createResizeObserver(fit);
    resizeObserver.observe(options.host);
    animationFrame = options.requestFrame(() => {
      fit();
      if (active && !options.disabled()) terminal?.focus();
    });
  } catch (error) {
    reportError(error);
    dispose();
  }

  return {
    syncOutput(output: string) {
      if (active) controller?.syncOutput(output);
    },
    setDisabled(disabled: boolean) {
      if (active && terminal) terminal.options.disableStdin = disabled;
    },
    dispose,
  };
}

export function createSshTerminalView(runtimeFactory: typeof createSshTerminalRuntime = createSshTerminalRuntime) {
  return function SshTerminalViewComponent({ sessionId, output, disabled, onInput, onResize, onCopy, onError }: SshTerminalViewProps) {
    const hostRef = useRef<HTMLDivElement>(null);
    const runtimeRef = useRef<ReturnType<typeof createSshTerminalRuntime> | null>(null);
    const disabledRef = useRef(disabled);
    const callbacksRef = useRef({ onInput, onResize, onCopy, onError });

    disabledRef.current = disabled;
    callbacksRef.current = { onInput, onResize, onCopy, onError };

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;

      const runtime = runtimeFactory({
        host,
        platform: navigator.platform.startsWith("Mac") ? "mac" : "other",
        disabled: () => disabledRef.current,
        callbacks: () => callbacksRef.current,
        createTerminal: (options) => new Terminal(options),
        createFitAddon: () => new FitAddon(),
        createController: createSshTerminalController,
        createResizeObserver: (listener) => new ResizeObserver(listener),
        requestFrame: (listener) => requestAnimationFrame(listener),
        cancelFrame: (handle) => cancelAnimationFrame(handle),
      });
      runtimeRef.current = runtime;

      return () => {
        runtime.dispose();
        if (runtimeRef.current === runtime) runtimeRef.current = null;
      };
    }, [sessionId]);

    useEffect(() => {
      runtimeRef.current?.syncOutput(output);
    }, [output, sessionId]);

    useEffect(() => {
      runtimeRef.current?.setDisabled(disabled);
    }, [disabled, sessionId]);

    return <div className="ssh-terminal-shell"><div className="ssh-terminal-host" ref={hostRef} aria-label="SSH 交互终端" /></div>;
  };
}

export const SshTerminalView = createSshTerminalView();
