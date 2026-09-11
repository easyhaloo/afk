/// <reference types="vite/client" />

import type {
  AgentRuntime as AgentRuntimeDto,
  AppearancePreferences as AppearancePreferencesDto,
  CanvasTemplateNode as CanvasTemplateNodeDto,
  CliCapability as CliCapabilityDto,
  DesktopApi,
  LoopStatus as LoopStatusDto,
  RuntimeEvent as RuntimeEventDto,
  Snapshot as SnapshotDto,
  WorkflowConfigSummary as WorkflowConfigSummaryDto,
  WorkflowRunSummary as WorkflowRunSummaryDto,
  WorkflowTemplateStepSummary as WorkflowTemplateStepSummaryDto,
  WorkflowTemplateSummary as WorkflowTemplateSummaryDto,
} from "../shared/ipc-contract";

declare global {
  type RuntimeEvent = RuntimeEventDto;
  type AgentRuntime = AgentRuntimeDto;
  type CliCapability = CliCapabilityDto;
  type CanvasTemplateNode = CanvasTemplateNodeDto;
  type WorkflowTemplateStepSummary = WorkflowTemplateStepSummaryDto;
  type WorkflowTemplateSummary = WorkflowTemplateSummaryDto;
  type WorkflowConfigSummary = WorkflowConfigSummaryDto;
  type WorkflowRunSummary = WorkflowRunSummaryDto;
  type LoopStatus = LoopStatusDto;
  type AppearancePreferences = AppearancePreferencesDto;
  type Snapshot = SnapshotDto;

  interface Window {
    afkDesktop: DesktopApi;
  }
}

export {};
