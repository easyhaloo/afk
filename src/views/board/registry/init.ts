/**
 * Registry initialization - Call once at app startup
 */
import { registerAllViews } from './views.js';
import { registerAllLoadingPhases } from './loading-init.js';
import type { BoardRuntimePorts } from '../../app/runtime-ports.js';

let viewsInitialized = false;
let loadingPhasesInitialized = false;

/**
 * The board's own views.
 *
 * They are the board's vocabulary, not the runtime's, so registering them
 * needs nothing from outside and stays callable with no arguments.
 */
export function initRegistry(): void {
  if (viewsInitialized) return;
  registerAllViews();
  viewsInitialized = true;
}

/**
 * The board's startup sequence.
 *
 * The first phase reads the tracker configuration, so the phases are
 * registered against the runtime's ports rather than against the runtime's
 * internals. The guard is separate from the views' one because the two
 * registries are separate: registering the phases twice would throw, and
 * registering the views twice would throw the same way.
 */
export function initLoadingPhases(ports: BoardRuntimePorts): void {
  if (loadingPhasesInitialized) return;
  registerAllLoadingPhases(ports);
  loadingPhasesInitialized = true;
}
