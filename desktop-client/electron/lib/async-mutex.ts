/**
 * Promise-chain serializers for atomic store operations.
 *
 * A store that changes a document reads it, changes it and writes it
 * back, so two writers of one document have to take turns: a read and a
 * write that overlap lose one of the changes.  Two writers of different
 * documents do not have to wait for each other, so the lock is per
 * document rather than global.
 */

const keyedQueues = new Map<string, Promise<void>>();

export function createKeyedMutex(): {
  run: <U>(key: string, op: () => Promise<U>) => Promise<U>;
} {
  const mutexes = keyedQueues;
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
