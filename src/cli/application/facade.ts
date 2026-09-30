import type {
  QueryExecutionHistoryInput,
  QueryExecutionHistoryResult,
} from '@afk/application';

export interface ApplicationFacade {
  queryExecutionHistory(input: QueryExecutionHistoryInput): Promise<QueryExecutionHistoryResult>;
}
