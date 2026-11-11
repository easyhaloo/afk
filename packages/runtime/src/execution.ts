export { executeWorkItem, reconcileWorkItemMerge, type ExecuteWorkItemInput, type ExecuteWorkItemResult } from './application/workflows/execute-work-item.js';
export { readExecutionManifest } from './application/workflows/execution-manifest.js';
export { resolveWorkflowRunRequest } from './application/workflows/run-request.js';
export { parseExecutionPlan, createExecutionPlan, type ExecutionPlan } from './domain/backlog/execution-plan.js';
export { scheduleWorkItems, scheduleWaitReason, describeScheduleWaitReason, inventoryBackoffMs, type ScheduleOptions, type ScheduleResult,
  type ScheduleStatus, type ScheduleWaitContext, type ScheduleWaitReason, type ScheduleWaitingItem, type ScheduleInventory, type ScheduleScopeReport } from './application/runners/scheduler.js';
export { assessScheduleScope, computeScheduleScope, type ScheduleScope, type ScheduleScopeAssessment } from './domain/backlog/schedule-scope.js';
export { inspectWorkspaceDisk, type WorkspaceDiskReport } from './application/workflows/workspace-disk.js';
export { ExperienceStore, type ExperienceRecord, type ExperienceStatus, type RecordFailureInput, type ExperienceVerification, type ExperienceExchange, type ExperienceMetrics } from './application/learning/experience-store.js';
export { experienceStorePath, experienceScope, verifyExperienceRun, verifyApplicableExperience, verifyAdoptionRun,
  resolveExperienceQueryContext, recordSuccessfulExperience } from './application/learning/runtime.js';
export { experienceQueryContextSchema, type ExperienceQueryContext } from './application/learning/experience-store.js';
export { DISTILLATION_LIMITS, learningScopeSchema, evidenceRefSchema, distillationRequestSchema,
  candidateStateSchema, candidateProposalSchema, distillationOutputSchema, distillationKey,
  parseDistillationOutput, assertCandidateTransition, type EvidenceRef as LearningEvidenceRef,
  type DistillationRequest, type CandidateProposal, type DistillationOutput, type AssetKind,
  type CandidateState } from './application/learning/contracts.js';
export { buildEvidencePack, validateEvidencePack, saveEvidencePack, loadEvidencePack,
  type EvidencePack, type EvidenceSourceInput, type EvidenceSource, type EvidenceEntry } from './application/learning/evidence.js';
export { buildAnalysisPrompt, parseAnalysisOutput, buildRetroPrompt, parseModelJson,
  retroModelOutputSchema, retroReportSchema } from './application/learning/analysis.js';
export { executeAnalysis, type AnalysisExecutionInput, type AnalysisExecutionResult } from './application/learning/analysis-runner.js';
export { reconcileDistillationSources, submitLearningCorrection,
  type ReconcileDistillationOptions, type DistillationReconciliation } from './application/learning/intake.js';
export { LearningWorker, learningDirectory, queryLearningState, submitDistillation,
  type LearningJob, type LearningState, type LearningWorkerOptions, type LearningWorkerResult } from './application/learning/worker.js';
export type { LearningCandidate, AnalysisAttempt } from './application/learning/candidate-store.js';
export { validateLearningCandidate, type LearningValidationResult, type LearningValidationChecker,
  type LearningValidationDependencies, type LearningValidationCommitSnapshot } from './application/learning/validation.js';
export { validateConfiguredLearningCandidate, validationConfigurationSchema, type ValidationConfiguration,
  type ValidationRuntimeOptions, type ValidationProviderBinding } from './application/learning/validation-runtime.js';
export { KnowledgeContextProvider, knowledgeConfigurationSchema, prepareConfiguredKnowledge, publishConfiguredKnowledge,
  reconcileConfiguredKnowledge, type KnowledgeConfiguration, type KnowledgeRuntimeOptions } from './application/learning/knowledge-runtime.js';
