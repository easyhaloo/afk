/**
 * The resolution now lives in the compiler, next to the compilation it feeds:
 * the plan the runtime executes is compiled in one place, and the resolver's
 * own plan shape is internal to that place.
 *
 * This module keeps the path the desktop client's canvas-agreement test reads
 * the levels from.
 */
export { resolveExecutionPlan } from './compiler.js';
