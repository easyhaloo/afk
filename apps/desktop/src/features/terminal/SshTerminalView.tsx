import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ILinkHandler, type ITerminalAddon, type ITerminalOptions } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import {
  createSshTerminalController,
  type SshTerminalControllerOptions,
  type SshTerminalPort,
} from "./ssh-terminal-controller.js";
import type { TerminalPlatform } from "./ssh-terminal-model.js";
import "./ssh-terminal.css";

type MaybePromise = Promise<unknown> | void;

export type SshTerminalOperation = "copy" | "input" | "resize" | "terminal";

export type SshTerminalViewProps = {
  sessionId: string;
  output: string;
  disabled: boolean;
  fontSize?: number;
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

const TERMINAL_THEMES = {
  dark: {
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
  light: {
    // page base --paper-in: #e4d9c0 | panel --paper: #f0e8d5 | primary --ink-main: #2e2416
    // secondary --ink-dim: #63543d | accent --accent: #2e6640 | warn --warn: #6b480d | fail --fail: #9a3c34
    background: "#e4d9c0",
    foreground: "#2e2416",
    cursor: "#2e2416",
    cursorAccent: "#e4d9c0",
    selectionBackground: "#e8dec6",
    // The ANSI ramp assumes a dark background, so on cream paper it has to
    // invert: "bright" means more prominent, which here means darker and more
    // saturated, not lighter. An earlier pass ran bright* lighter than its base
    // colour, which made bold red a pale salmon at 2:1 and left brightWhite
    // three hex units from black -- bold text indistinguishable from normal.
    // Every value below clears 4.5:1 on --paper (#f0e8d5).
    black: "#3a3129",
    red: "#a04a4a",
    green: "#357245",
    yellow: "#86601c",
    blue: "#3f5a86",
    magenta: "#82597a",
    cyan: "#3b7171",
    white: "#5c5348",
    brightBlack: "#6e645a",
    brightRed: "#8c3030",
    brightGreen: "#2e6640",
    brightYellow: "#6b480d",
    brightBlue: "#2f4a76",
    brightMagenta: "#6b4062",
    brightCyan: "#2f6565",
    brightWhite: "#1a1409",
  },
} as const;

// The runtime theme is set once at creation and re-applied by watching the
// attribute main.tsx already writes. That attribute is the runtime source of
// truth; threading `appearance` down through TerminalSheet would touch two
// files this module does not own, for the same result.
export type TerminalThemeName = keyof typeof TERMINAL_THEMES;

function readTheme(): TerminalThemeName {
  // Unit tests run in the node environment, where there is no document; the
  // runtime throws inside the surrounding try and the terminal never builds.
  const theme = typeof document === "undefined" ? undefined : document.documentElement.dataset.afkTheme;
  return theme === "light" ? "light" : "dark";
}

export type ThemeWatcher = { disconnect(): void };

/** Calls `onChange` whenever the app's theme flips, with an open session running. */
export function watchTheme(onChange: (theme: TerminalThemeName) => void): ThemeWatcher {
  // Test environments here are partial: some have no `document`, and
  // terminal-sheet.test.ts has a document but no MutationObserver. A terminal
  // that never recolours is a cosmetic loss; one that throws on mount is a
  // broken page. Degrade to a no-op watcher.
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    return { disconnect: () => {} };
  }
  const observer = new MutationObserver(() => onChange(readTheme()));
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-afk-theme"] });
  return { disconnect: () => observer.disconnect() };
}

export function sshTerminalOptions(): ITerminalOptions {
  return {
    cursorBlink: true,
    convertEol: false,
    scrollback: 5000,
    fontFamily: '"SFMono-Regular", "SF Mono", "DM Mono", ui-monospace, monospace',
    fontSize: 11,
    linkHandler: blockedOscLinkHandler,
    theme: TERMINAL_THEMES[readTheme()],
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
    setFontSize(fontSize: number) {
      if (!active || !terminal) return;
      terminal.options.fontSize = fontSize;
      try {
        fitAddon?.fit();
      } catch (error) {
        reportError(error);
      }
    },
    setTheme(theme: TerminalThemeName) {
      if (!active || !terminal) return;
      terminal.options.theme = TERMINAL_THEMES[theme];
    },
    dispose,
  };
}

export function createSshTerminalView(
  runtimeFactory: typeof createSshTerminalRuntime = createSshTerminalRuntime,
  themeWatcher: typeof watchTheme = watchTheme,
) {
  return function SshTerminalViewComponent({ sessionId, output, disabled, fontSize = 11, onInput, onResize, onCopy, onError }: SshTerminalViewProps) {
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

    useEffect(() => {
      runtimeRef.current?.setFontSize(fontSize);
    }, [fontSize, sessionId]);

    // Runs after the creation effect above, so the runtime already exists.
    useEffect(() => {
      const watcher = themeWatcher(theme => runtimeRef.current?.setTheme(theme));
      return () => watcher.disconnect();
    }, [sessionId]);

    return <div className="ssh-terminal-shell"><div className="ssh-terminal-host" ref={hostRef} aria-label="SSH 交互终端" /></div>;
  };
}

export const SshTerminalView = createSshTerminalView();
