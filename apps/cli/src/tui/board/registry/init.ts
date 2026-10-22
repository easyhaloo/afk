/**
 * Registry initialization - Call once at app startup
 */
import { registerAllViews } from './views.js';
import { registerAllLoadingPhases } from './loading-init.js';

let initialized = false;

export function initRegistry(): void {
  if (initialized) return;
  registerAllViews();
  registerAllLoadingPhases();
  initialized = true;
}
