export type BacklogState = 'ready' | 'rework' | 'in_progress' | 'verification' | 'merge_ready' | 'done' | 'blocked';
export type BacklogExecutionMode = 'afk' | 'hitl';

export interface BacklogProviderCapabilities {
  atomicClaim: boolean;
  tags: boolean;
  initialization: boolean;
}
