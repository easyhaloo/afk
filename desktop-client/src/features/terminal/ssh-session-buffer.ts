import type { SshSession } from "../../../shared/ssh-contract";

export type SshSessionEvent =
  | { type: "data"; data: string }
  | { type: "exit"; code: number };

export type SshTerminalState = {
  open: boolean;
  pane: string;
  mode: "tmux" | "ssh";
  sshSession?: SshSession;
  publicKeyPath?: string;
};

type BufferOptions = {
  maxSessions?: number;
  maxOutputCharsPerSession?: number;
  maxEventsPerSession?: number;
  maxClosedSessions?: number;
};

type BufferEntry = {
  events: SshSessionEvent[];
  outputChars: number;
};

export function applySshSessionEvents(state: SshTerminalState, sessionId: string, events: readonly SshSessionEvent[]) {
  if (state.sshSession?.id !== sessionId) return state;

  return events.reduce<SshTerminalState>((current, event) => {
    if (event.type === "data") return { ...current, pane: current.pane + event.data };
    return {
      ...current,
      pane: `${current.pane}\n\n[SSH 会话已退出，退出码 ${event.code}]`,
      sshSession: current.sshSession ? { ...current.sshSession, state: "closed" } : undefined,
    };
  }, state);
}

export function createEarlySshSessionBuffer(options: BufferOptions = {}) {
  const maxSessions = options.maxSessions ?? 8;
  const maxOutputCharsPerSession = options.maxOutputCharsPerSession ?? 64 * 1024;
  const maxEventsPerSession = options.maxEventsPerSession ?? 128;
  const maxClosedSessions = options.maxClosedSessions ?? 32;
  const entries = new Map<string, BufferEntry>();
  const closedSessionIds = new Set<string>();

  const entryFor = (sessionId: string) => {
    const existing = entries.get(sessionId);
    if (existing) return existing;
    while (entries.size >= maxSessions) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    const entry = { events: [], outputChars: 0 };
    entries.set(sessionId, entry);
    return entry;
  };

  return {
    pushData(sessionId: string, data: string) {
      if (!sessionId || !data || closedSessionIds.has(sessionId)) return;
      const entry = entryFor(sessionId);
      const remaining = maxOutputCharsPerSession - entry.outputChars;
      if (remaining <= 0) return;
      const boundedData = data.slice(0, remaining);
      const lastEvent = entry.events.at(-1);
      if (lastEvent?.type === "data") lastEvent.data += boundedData;
      else if (entry.events.length < maxEventsPerSession) entry.events.push({ type: "data", data: boundedData });
      else return;
      entry.outputChars += boundedData.length;
    },
    pushExit(sessionId: string, code: number) {
      if (!sessionId || closedSessionIds.has(sessionId)) return;
      const entry = entryFor(sessionId);
      if (entry.events.length < maxEventsPerSession) entry.events.push({ type: "exit", code });
    },
    open(sessionId: string) {
      closedSessionIds.delete(sessionId);
      const events = entries.get(sessionId)?.events ?? [];
      entries.delete(sessionId);
      return events;
    },
    close(sessionId: string) {
      if (!sessionId) return;
      entries.delete(sessionId);
      closedSessionIds.delete(sessionId);
      closedSessionIds.add(sessionId);
      while (closedSessionIds.size > maxClosedSessions) {
        const oldest = closedSessionIds.values().next().value;
        if (oldest === undefined) break;
        closedSessionIds.delete(oldest);
      }
    },
    clear(sessionId: string) {
      entries.delete(sessionId);
      closedSessionIds.delete(sessionId);
    },
    clearAll() {
      entries.clear();
      closedSessionIds.clear();
    },
  };
}
