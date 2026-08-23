export type WorkflowGraphFormat = 'json' | 'archify-json';
export type WorkflowGraphState = 'missing' | 'generating' | 'trusted' | 'stale' | 'rejected';

export interface WorkflowGraphStatus {
  readonly state: WorkflowGraphState;
  readonly templateId: string;
  readonly inputHash?: string;
  readonly trustedInputHash?: string;
  readonly graph?: unknown;
  readonly diagnostics: readonly { readonly severity: 'info' | 'warning' | 'error'; readonly code: string; readonly message: string }[];
}

export interface WorkflowGraphGenerateRequest { readonly workspace: string; readonly templateId: string; readonly format?: WorkflowGraphFormat; }
export interface WorkflowGraphGenerateResult { readonly status: WorkflowGraphStatus; readonly outputPath?: string; }

export const GRAPH_IPC_CHANNELS = {
  status: 'afk:graph:status',
  generate: 'afk:graph:generate',
  export: 'afk:graph:export',
} as const;
