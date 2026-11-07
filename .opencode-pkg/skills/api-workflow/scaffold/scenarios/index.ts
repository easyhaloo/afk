// ============================================================
// API Workflow Scenarios Index
// ============================================================
// Export all scenario modules for easy importing.
//
// IMPORTANT NAMING RULES:
// 1. Test files MUST end with `.spec.ts` (Playwright requirement)
//    ❌ lint-flow.ts       → ✅ lint-flow.spec.ts
//    ❌ review-flow.ts     → ✅ review-flow.spec.ts
//
// 2. Export step functions and types for reusability
//    - step_* functions: individual API calls
//    - verify_* functions: assertions
//    - Type definitions for API responses
//
// Usage:
//   import { step_triggerLint, step_pollLintRun } from './scenarios/lint-flow';
//   import * as lintFlow from './scenarios/lint-flow';
// ============================================================

// Re-export all step functions and types
// Add exports here as you create new scenario files
export * from './order-flow.spec';
// export * from './lint-flow';
// export * from './review-flow';