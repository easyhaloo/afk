/**
 * Built-in workflow templates (EXECUTION-DESIGN.md §10).
 *
 *   issue-implementation   — current AFK two-phase flow (implement → verify → MR)
 *   simple-loop            — single step that loops until the agent reports done
 *   sequential-review      — implement → review → fix-if-failed
 *   parallel-planner       — multiple planners in parallel
 *   planner-with-review    — parallel planners → review → fix
 *
 * The prompt text is intentionally short — the runner interpolates the
 * template's prompt with the iid / branch / worktree at execution time.
 */

import type { WorkflowTemplate } from './types';

export function builtinTemplates(): WorkflowTemplate[] {
  return [
    issueImplementation(),
    qaVerification(),
    simpleLoop(),
    sequentialReview(),
    parallelPlanner(),
    plannerWithReview(),
  ];
}

// ── issue-implementation ───────────────────────────────────────────────────

/**
 * Default template: implement → verify-ac → publish change → queue QA.
 */
function issueImplementation(): WorkflowTemplate {
  return {
    name: 'issue-implementation',
    version: 1,
    description: 'Implement an issue end-to-end: code, verify AC, open MR, QA.',
    defaultBranch: { type: 'issue', iid: 0 }, // runner overrides per-run
    defaultProvider: 'claude-code',
    steps: [
      {
        id: 'implement',
        role: 'implementer',
        prompt: '/goal 实现 issue #{iid} 的功能需求。每完成一个 AC 就提交一次。',
        branch: { type: 'issue', iid: 0 },
      },
      {
        id: 'verify-ac',
        role: 'verifier',
        prompt: '/goal 验证 issue #{iid} 的 AC 全部通过。',
        branch: { type: 'issue', iid: 0 },
        dependsOn: ['implement'],
      },
      {
        id: 'publish',
        kind: 'system',
        action: 'publish-change',
        dependsOn: ['verify-ac'],
        when: { step: 'verify-ac', equals: 'completed' },
      },
      {
        id: 'queue-qa',
        kind: 'system',
        action: 'queue-qa',
        dependsOn: ['publish'],
      },
    ],
  };
}

function qaVerification(): WorkflowTemplate {
  return {
    name: 'pre-merge-qa-verification',
    version: 1,
    description: 'Pre-merge integration QA verification. Only an explicit AC PASS may merge an MR.',
    steps: [{
      id: 'verify-ac', kind: 'agent', role: 'verifier', completion: 'goal_complete',
      prompt: '/goal 验证 issue #{iid} 的 AC 全部通过，并返回 PASS 或 FAIL。',
    }],
  };
}

// ── simple-loop ────────────────────────────────────────────────────────────

/**
 * Single-step template: one agent loop that polls for completion. Useful
 * for ad-hoc tasks where the multi-phase structure is overkill.
 */
function simpleLoop(): WorkflowTemplate {
  return {
    name: 'simple-loop',
    version: 1,
    description: 'One agent loop until completion (single-step).',
    steps: [
      {
        id: 'run',
        role: 'agent',
        prompt: '/goal 执行任务直到完成。',
      },
    ],
  };
}

// ── sequential-review ──────────────────────────────────────────────────────

/**
 * Implement → review → conditional fix. The fix step only runs when the
 * review step reported 'failed' — see the when clause.
 */
function sequentialReview(): WorkflowTemplate {
  return {
    name: 'sequential-review',
    version: 1,
    description: 'Implement, then review; fix only if review failed.',
    steps: [
      {
        id: 'implement',
        role: 'implementer',
        prompt: '/goal 实现需求。',
      },
      {
        id: 'review',
        role: 'reviewer',
        prompt: '/goal 审查实现并报告通过 / 失败。',
        dependsOn: ['implement'],
      },
      {
        id: 'fix',
        role: 'implementer',
        prompt: '/goal 根据 review 的反馈修复问题。',
        dependsOn: ['review'],
        when: { step: 'review', equals: 'failed' },
      },
    ],
  };
}

// ── parallel-planner ───────────────────────────────────────────────────────

/**
 * Three planners running in parallel via the `parallel: 'planners'` group.
 * The runner resolves the dependency graph and runs all steps at the same
 * level concurrently. Each planner works on its own branch / worktree
 * (mandatory per the design: "并行步骤必须显式使用独立 branch/worktree").
 */
function parallelPlanner(): WorkflowTemplate {
  return {
    name: 'parallel-planner',
    version: 1,
    description: 'Three planners work in parallel on the same issue.',
    steps: [
      {
        id: 'plan-frontend',
        role: 'planner',
        prompt: '/goal 规划前端实现方案。',
        parallel: 'planners',
        branch: { type: 'named', branch: 'plan-frontend' },
      },
      {
        id: 'plan-backend',
        role: 'planner',
        prompt: '/goal 规划后端实现方案。',
        parallel: 'planners',
        branch: { type: 'named', branch: 'plan-backend' },
      },
      {
        id: 'plan-infra',
        role: 'planner',
        prompt: '/goal 规划基础设施方案。',
        parallel: 'planners',
        branch: { type: 'named', branch: 'plan-infra' },
      },
    ],
  };
}

// ── planner-with-review ────────────────────────────────────────────────────

/**
 * Parallel planners → review all plans → conditional fix.
 * The review step has dependsOn pointing to each planner (resolved by the
 * resolver; all three must complete before review).
 */
function plannerWithReview(): WorkflowTemplate {
  return {
    name: 'planner-with-review',
    version: 1,
    description: 'Parallel planners, then a single review of all plans.',
    steps: [
      {
        id: 'plan-frontend',
        role: 'planner',
        prompt: '/goal 规划前端。',
        parallel: 'planners',
        branch: { type: 'named', branch: 'plan-frontend' },
      },
      {
        id: 'plan-backend',
        role: 'planner',
        prompt: '/goal 规划后端。',
        parallel: 'planners',
        branch: { type: 'named', branch: 'plan-backend' },
      },
      {
        id: 'review',
        role: 'reviewer',
        prompt: '/goal 审查所有规划并报告问题。',
        dependsOn: ['plan-frontend', 'plan-backend'],
      },
      {
        id: 'fix',
        role: 'implementer',
        prompt: '/goal 修复规划中的问题。',
        dependsOn: ['review'],
        when: { step: 'review', equals: 'failed' },
      },
    ],
  };
}
