/**
 * Registry initialization - Call once at app startup
 */
import { registerAllViews } from './views';

let initialized = false;

export function initRegistry(): void {
  if (initialized) return;
  registerAllViews();
  initialized = true;
}
