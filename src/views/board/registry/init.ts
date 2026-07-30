/**
 * Registry initialization - Call once at app startup
 */
import { registerAllViews } from './views';
import { registerAllLoadingPhases } from './loading-init';

let initialized = false;

export function initRegistry(): void {
  if (initialized) return;
  registerAllViews();
  registerAllLoadingPhases();
  initialized = true;
}
