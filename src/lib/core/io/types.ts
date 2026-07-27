// Signal types for workflow communication
export type SignalType = 'goal_complete' | 'ac_result' | 'handoff_ready';

export interface Signal {
  type: SignalType;
  timestamp: string;
  summary?: string;
  sha?: string;
  result?: 'PASS' | 'FAIL';
  tests_run?: number;
  tests_passed?: number;
}
