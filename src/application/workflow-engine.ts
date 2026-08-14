import { promises as fs } from 'fs';
import { join } from 'path';
import { simpleGit } from 'simple-git';
import { WorktreeManager } from '../infrastructure/git/index';
import { TmuxClient, createTmuxClient } from '../infrastructure/tmux/index';
import { createSandboxProvider } from '../infrastructure/sandbox/index';
import { createAgentProvider } from '../domain/agents/index';
import type {
  Sandbox,
  SandboxProvider,
  SandboxProviderName,
  AgentExecution,
  ExecutionResult,
} from '../infrastructure/sandbox/types';
import type { AgentProvider, AgentProviderName, SessionSnapshot, ExecutionMode } from '../domain/agents/types';
import { getTokenUsage, configureStatusline, logger } from '../infrastructure/io/index';
import { getWorkflowConfig } from '../infrastructure/config/manager';
import { loadModules, parseModuleParams } from './modules/_registry';
import { LifecycleDispatcher, type LifecycleModule, type LifecycleContext } from './workflows/lifecycle';
import { Watchdog, createWatchdog } from './workflows/watchdog';
import type { WorkflowConfig } from '../infrastructure/config/manager';
import { HandoffCoordinator, handoffDocPath } from './workflows/handoff';
import { attemptNativeResume } from './workflows/resume';
import { BudgetManager } from './workflows/budget';
import type { InitContext } from './workflows/lifecycle';
import { defaultSessionStoreChain } from './sessions/chain';
import { TemplateLoader } from '../domain/templates/loader';
import { PlanExecutor } from './workflows/plan-executor';
import { SystemActionExecutor } from './workflows/system-actions';
import { RunResourceScope, type RunOutcomeStatus } from './workflows/resource-scope';
import {
  buildExecutionPrompt,
  isAcVerificationPass,
  parseAcVerificationFailure,
  type AcVerificationFailure,
  type CompletionKind,
} from './workflows/execution-protocol';
import { shouldReusePrimaryWorktree } from './workflows/worktree-selection';
import type { PluginRuntime } from './plugins/runtime';
import type { Step, StepResult } from '../domain/templates/types';
import type { BranchHandle } from '../domain/branches/types';
import type { ProviderBundle } from './providers';
import type { BacklogClaim, BacklogItem, BacklogState } from '../domain/backlog/index';
import { TaskRuntimeManager } from './runtime/task-runtime';

/**
 * Preserve the provider boundary details when an agent execution fails.
 * The result may contain provider-native structured output, so keep it in the
 * message without assuming a particular provider schema.
 */