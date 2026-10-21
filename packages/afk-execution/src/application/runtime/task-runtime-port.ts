import type { TaskRuntimePort } from '@afk/application';
import {
  TaskRuntimeManager,
  TaskRuntimeReader,
  TaskRuntimeStore,
  type TaskRuntimeReaderOptions,
} from './task-runtime.js';

/**
 * The runtime's records, behind the port.
 *
 * One store, two views of it: the manager answers "what is still going
 * and what has finished" and the reader answers "which records belong to
 * this work item". They read the same files, so a board and a desktop
 * cannot show different runs.
 */
export function createTaskRuntimePort(options: TaskRuntimeReaderOptions = {}): TaskRuntimePort {
  const store = new TaskRuntimeStore(options.root);
  const reader = new TaskRuntimeReader(options, store);
  const manager = new TaskRuntimeManager(store, options);
  return {
    listActive: () => manager.listActive(),
    listArchive: () => manager.listArchive(),
    list: (query) => reader.list(query),
    find: (runId, identity) => reader.find(runId, identity),
  };
}
