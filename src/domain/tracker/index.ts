import type { Platform } from './types';
export type { TrackerProvider, Platform } from './types';
export type {
  TrackedIssue,
  TrackedMR,
  ListOptions,
  CreateIssueOptions,
  UpdateIssueOptions,
  LabelDelta,
  ListMROptions,
  AcceptanceCriteria,
  LinkType,
} from './types';
export type {
  BacklogItem,
  BacklogProvider,
  BacklogState,
  BacklogExecutionMode,
  BacklogProviderCapabilities,
} from '../backlog';

export interface TrackerConfig {
  platform?: Platform;
  projectId?: string;
  cwd?: string;
}
