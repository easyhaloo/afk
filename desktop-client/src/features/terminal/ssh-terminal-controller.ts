import {
  terminalOutputUpdate,
  xtermKeyAction,
  type TerminalPlatform,
} from "./ssh-terminal-model";

type MaybePromise = void | Promise<void>;

type TerminalKeyEvent = Pick<
  KeyboardEvent,
  "type" | "key" | "metaKey" | "ctrlKey" | "shiftKey"
>;

type Disposable = {
  dispose(): void;
};

export type SshTerminalPort = {
  write(data: string): void;
  hasSelection(): boolean;
  getSelection(): string;
  onData(listener: (data: string) => void): Disposable;
  onResize(listener: (size: { cols: number; rows: number }) => void): Disposable;
  attachCustomKeyEventHandler(listener: (event: TerminalKeyEvent) => boolean): void;
};

export type SshTerminalControllerOptions = {
  terminal: SshTerminalPort;
  platform: TerminalPlatform;
  input(data: string): MaybePromise;
  resize(cols: number, rows: number): MaybePromise;
  copy(data: string): MaybePromise;
  reportError(error: unknown): void;
};

type TerminalSize = {
  cols: number;
  rows: number;
  key: string;
};

export function createSshTerminalController(options: SshTerminalControllerOptions) {
  const { terminal, platform, input, resize, copy, reportError } = options;
  let active = true;
  let previousOutput = "";
  let appliedSize = "";
  let desiredSize: TerminalSize | null = null;
  let resizeInFlight = false;

  const report = (error: unknown) => {
    if (!active) {
      return;
    }

    try {
      reportError(error);
    } catch {}
  };

  const invoke = (callback: () => MaybePromise) => {
    if (!active) {
      return;
    }

    try {
      void Promise.resolve(callback()).catch(report);
    } catch (error) {
      report(error);
    }
  };

  const dataDisposable = terminal.onData((data) => {
    invoke(() => input(data));
  });

  const pumpResize = () => {
    if (
      !active ||
      resizeInFlight ||
      !desiredSize ||
      desiredSize.key === appliedSize
    ) {
      return;
    }

    const targetSize = desiredSize;
    resizeInFlight = true;

    const finishResizeSuccess = () => {
      resizeInFlight = false;
      if (!active) {
        return;
      }

      appliedSize = targetSize.key;
      pumpResize();
    };

    const finishResizeFailure = (error: unknown) => {
      resizeInFlight = false;
      if (!active) {
        return;
      }

      report(error);
      if (desiredSize?.key === targetSize.key) {
        desiredSize = null;
      }
      pumpResize();
    };

    try {
      void Promise.resolve(resize(targetSize.cols, targetSize.rows)).then(
        finishResizeSuccess,
        finishResizeFailure,
      );
    } catch (error) {
      finishResizeFailure(error);
    }
  };

  const resizeDisposable = terminal.onResize(({ cols, rows }) => {
    if (!active) {
      return;
    }

    const key = `${cols}:${rows}`;
    if (desiredSize?.key === key) {
      return;
    }

    desiredSize = { cols, rows, key };
    pumpResize();
  });

  terminal.attachCustomKeyEventHandler((event) => {
    if (!active || event.type !== "keydown") {
      return true;
    }

    const action = xtermKeyAction({
      platform,
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      hasSelection: terminal.hasSelection(),
    });

    if (action === "copy") {
      invoke(() => copy(terminal.getSelection()));
      return false;
    }

    if (action === "ignore") {
      return false;
    }

    return true;
  });

  return {
    syncOutput(nextOutput: string) {
      if (!active) {
        return;
      }

      const update = terminalOutputUpdate(previousOutput, nextOutput);
      try {
        if (update.reset) {
          terminal.write(`\u001bc${update.data}`);
        } else if (update.data) {
          terminal.write(update.data);
        }
        previousOutput = nextOutput;
      } catch (error) {
        report(error);
      }
    },
    dispose() {
      if (!active) {
        return;
      }

      active = false;
      dataDisposable.dispose();
      resizeDisposable.dispose();
    },
  };
}
