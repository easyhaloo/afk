import { queryExecutionHistory, type RunEventQueryPort } from "@afk/application";
import { parseExecutionQueryOptions, parseExecutionSummary, type ExecutionQueryOptions, type ExecutionSummary } from "../../shared/execution-contract.js";

type QueryPage = { executions: ExecutionSummary[]; nextCursor?: string };

export function createWorkItemExecutionQueryService(events: RunEventQueryPort) {
  return {
    async list(options: ExecutionQueryOptions = {}): Promise<QueryPage> {
      const input = parseExecutionQueryOptions(options);
      const page = await queryExecutionHistory(input, events);
      return {
        executions: page.executions.map(parseExecutionSummary),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      };
    },
  };
}
