/**
 * Promise-chain serializers for atomic store operations.
 * ponytail: global lock — per-key locks available if throughput matters.
 */

const queues = new Map<string, Promise<void>>();

export function createMutex<T>(): {
  run: <U>(op: () => Promise<U>) => Promise<U>;
} {
  const key = "singleton";
  return {
    run<U>(op: () => Promise<U>): Promise<U> {
      const previous = queues.get(key) ?? Promise.resolve();
      const next = previous.then(op, op);
      const recovered = next.then(() => undefined, () => undefined);
      queues.set(key, recovered);
      void recovered.then(() => {
        if (queues.get(key) === recovered) queues.delete(key);
      });
      return next;
    },
  };
}

export function createKeyedMutex(): {
  run: <U>(key: string, op: () => Promise<U>) => Promise<U>;
} {
  const mutexes = new Map<string, Promise<void>>();
  return {
    run<U>(key: string, op: () => Promise<U>): Promise<U> {
      const previous = mutexes.get(key) ?? Promise.resolve();
      let release: (() => void) | undefined;
      const mutex = previous.then(async () => {
        try {
          return await op();
        } finally {
          if (release) release();
        }
      });
      const cleanup = new Promise<void>((resolve) => {
        release = resolve;
      });
      mutexes.set(
        key,
        Promise.race([mutex.then(() => cleanup), cleanup.then(() => undefined)]).then(() => undefined),
      );
      return mutex as Promise<U>;
    },
  };
}
