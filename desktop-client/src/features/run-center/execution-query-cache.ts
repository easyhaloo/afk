/**
 * A shared query cache for the renderer.
 *
 * The module owns the query state of one key: its value, its error, its
 * subscribers, one in-flight request per channel and one poll timer. Hooks
 * read an entry instead of running a fetch loop of their own, so two views of
 * the same key cost one round trip to the main process and one timer.
 *
 * The module is plain TypeScript: no React, no node builtins. The React
 * adapters live in the hooks that use this cache.
 */

/** What every subscriber of a key observes. */
export type QuerySnapshot<Value> = { value: Value; error: string };

/** Told whenever the value or the error of a key changes. */
export type QueryListener<Value> = (snapshot: QuerySnapshot<Value>) => void;

/** A request against the main process. It reports through the entry. */
export type QueryTask = () => Promise<void>;

export type QueryEntry<Value> = {
  readonly key: string;
  /** False once the entry lost its last subscriber; a late response is dropped. */
  readonly alive: boolean;
  /** The value and the error every subscriber of this key sees. */
  snapshot(): QuerySnapshot<Value>;
  /** Replace the value, clear the error, tell every subscriber. */
  publish(value: Value): void;
  /** Record the error, tell every subscriber. */
  fail(error: string): void;
  /** Clear the error without touching the value. */
  clearError(): void;
  /** Observe the entry. The returned function detaches this subscriber. */
  subscribe(listener: QueryListener<Value>): () => void;
  /** The task that refreshes this key. The poll and the invalidation reuse it. */
  setTask(task: QueryTask): void;
  /** Run the key's task. One refresh per key is in flight; a second caller joins it. */
  refresh(): Promise<void>;
  /** Run a task on a named channel. One request per channel is in flight. */
  request(channel: string, task: QueryTask): Promise<void>;
  /** Start the key's single poll timer. The returned function stops it. */
  poll(intervalMs: number): () => void;
  /** Tell every subscriber of the key to refetch. */
  invalidate(): void;
};

export type QueryCache<Value> = {
  /** The entry of a key, created on first use. */
  entry(key: string): QueryEntry<Value>;
  /** The current snapshot of a key, without creating an entry for it. */
  read(key: string): QuerySnapshot<Value>;
  /** Refetch one key for every subscriber of it. */
  invalidate(key: string): void;
  /** Refetch every key for every subscriber of it. */
  invalidateAll(): void;
};

export function createQueryCache<Value>(createValue: (key: string) => Value): QueryCache<Value> {
  type Internal = QueryEntry<Value> & {
    value: Value;
    error: string;
    destroyed: boolean;
    listeners: Set<QueryListener<Value>>;
    holders: number;
    pollers: number;
    timer?: ReturnType<typeof setInterval>;
    task?: QueryTask;
    inFlight: Map<string, Promise<void>>;
  };

  const entries = new Map<string, Internal>();

  const notify = (entry: Internal) => {
    const snapshot: QuerySnapshot<Value> = { value: entry.value, error: entry.error };
    for (const listener of [...entry.listeners]) listener(snapshot);
  };

  // An entry outlives its subscribers only while somebody still holds it.
  // The last release drops the timer and marks the entry dead, so a response
  // that arrives afterwards is dropped instead of reviving stale state.
  const destroy = (entry: Internal) => {
    entry.destroyed = true;
    if (entry.timer !== undefined) {
      clearInterval(entry.timer);
      entry.timer = undefined;
    }
    entry.listeners.clear();
    entry.pollers = 0;
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
  };

  const run = (entry: Internal, channel: string, task: QueryTask): Promise<void> => {
    const started = entry.inFlight.get(channel);
    if (started) return started;
    const request = (async () => {
      try {
        await task();
      } catch (cause) {
        if (entry.destroyed) return;
        entry.error = cause instanceof Error ? cause.message : String(cause);
        notify(entry);
      }
    })();
    entry.inFlight.set(channel, request);
    void request.then(() => {
      if (entry.inFlight.get(channel) === request) entry.inFlight.delete(channel);
    });
    return request;
  };

  const createEntry = (key: string): Internal => {
    const entry: Internal = {
      key,
      value: createValue(key),
      error: "",
      destroyed: false,
      listeners: new Set(),
      holders: 0,
      pollers: 0,
      inFlight: new Map(),
      get alive() { return !entry.destroyed; },
      snapshot: () => ({ value: entry.value, error: entry.error }),
      publish: value => {
        if (entry.destroyed) return;
        entry.value = value;
        entry.error = "";
        notify(entry);
      },
      fail: error => {
        if (entry.destroyed) return;
        entry.error = error;
        notify(entry);
      },
      clearError: () => {
        if (entry.destroyed || entry.error === "") return;
        entry.error = "";
        notify(entry);
      },
      subscribe: listener => {
        entry.listeners.add(listener);
        entry.holders += 1;
        let attached = true;
        return () => {
          if (!attached) return;
          attached = false;
          entry.listeners.delete(listener);
          entry.holders -= 1;
          if (entry.holders === 0) destroy(entry);
        };
      },
      setTask: task => { entry.task = task; },
      refresh: () => {
        const task = entry.task;
        return task ? run(entry, "refresh", task) : Promise.resolve();
      },
      request: (channel, task) => run(entry, channel, task),
      poll: intervalMs => {
        entry.pollers += 1;
        if (entry.timer === undefined) {
          entry.timer = setInterval(() => {
            const task = entry.task;
            if (task) void run(entry, "refresh", task);
          }, intervalMs);
        }
        let polling = true;
        return () => {
          if (!polling) return;
          polling = false;
          entry.pollers -= 1;
          if (entry.pollers === 0 && entry.timer !== undefined) {
            clearInterval(entry.timer);
            entry.timer = undefined;
          }
        };
      },
      invalidate: () => {
        const task = entry.task;
        if (task) void run(entry, "refresh", task);
      },
    };
    entries.set(key, entry);
    return entry;
  };

  return {
    entry: key => entries.get(key) ?? createEntry(key),
    read: key => {
      const entry = entries.get(key);
      return entry ? { value: entry.value, error: entry.error } : { value: createValue(key), error: "" };
    },
    invalidate: key => {
      const entry = entries.get(key);
      if (entry) entry.invalidate();
    },
    invalidateAll: () => {
      for (const entry of [...entries.values()]) entry.invalidate();
    },
  };
}
