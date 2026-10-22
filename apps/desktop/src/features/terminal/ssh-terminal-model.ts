export type TerminalPlatform = "mac" | "other";
export type XtermKeyAction = "copy" | "ignore" | "native-paste" | "terminal";

export function terminalOutputUpdate(previous: string, next: string) {
  if (next === previous) {
    return { reset: false, data: "" };
  }

  if (next.startsWith(previous)) {
    return { reset: false, data: next.slice(previous.length) };
  }

  return { reset: true, data: next };
}

export function xtermKeyAction(input: {
  platform: TerminalPlatform;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  hasSelection: boolean;
}): XtermKeyAction {
  const key = input.key.toLowerCase();

  if (input.platform === "mac" && input.metaKey && key === "c" && input.hasSelection) {
    return "copy";
  }

  if (input.platform === "other" && input.ctrlKey && key === "c") {
    if (input.shiftKey) {
      return input.hasSelection ? "copy" : "ignore";
    }

    if (input.hasSelection) {
      return "copy";
    }
  }

  if (input.platform === "mac" && input.metaKey && key === "v") {
    return "native-paste";
  }

  if (input.platform === "other" && input.ctrlKey && input.shiftKey && key === "v") {
    return "native-paste";
  }

  return "terminal";
}
