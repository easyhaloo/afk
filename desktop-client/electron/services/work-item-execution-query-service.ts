import type { RunEventQueryPort } from "@afk/application";
import { loadApplication } from "../adapters/application-module";
import { parseExecutionQueryOptions, parseExecutionSummary, type ExecutionQueryOptions, type ExecutionSummary } from "../../shared/execution-contract";

type QueryPage = { executions: ExecutionSummary[]; nextCursor?: string };

export function createWorkItemExecutionQueryService(events: RunEventQueryPort) {
  return {
    async list(options: ExecutionQueryOptions = {}): Promise<QueryPage> {
      const input = parseExecutionQueryOptions(options);
      const application = loadApplication();
      const page = await application.queryExecutionHistory(input, events);
      return {
        executions: page.executions.map(parseExecutionSummary),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      };
    },
  };
}
