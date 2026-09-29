import { parseWorkItemId } from "../../shared/backlog-contract";
import { parseExecutionSummary, type ExecutionSummary } from "../../shared/execution-contract";
import { parseObject, parseRequiredString } from "../../shared/validation";

type QueryOptions = { workItemId?: string; limit?: number; since?: string };
type QueryPage = { executions: ExecutionSummary[]; nextCursor?: string };

export function createWorkItemExecutionQueryService(deps: {
  run: (args: string[]) => Promise<string>;
}) {
  return {
    async list(options: QueryOptions = {}): Promise<QueryPage> {
      const limit = options.limit ?? 25;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("execution query limit must be between 1 and 100");
      const workItemId = options.workItemId === undefined ? undefined : parseWorkItemId(options.workItemId);
      const args = ["observe", "executions"];
      if (workItemId) args.push("--work-item-id", workItemId);
      args.push("--limit", String(limit));
      if (options.since !== undefined) args.push("--since", parseRequiredString(options.since, "execution cursor"));
      args.push("--json");
      const page = parseObject(JSON.parse(await deps.run(args)) as unknown, "execution query result");
      if (!Array.isArray(page.executions)) throw new Error("execution query result has no executions");
      const executions = page.executions.filter(raw => {
        const candidate = parseObject(raw, "execution query item");
        return candidate.status !== "unknown" || candidate.workItemId !== "";
      }).map(raw => {
        const candidate = parseObject(raw, "execution query item");
        const id = parseWorkItemId(candidate.workItemId);
        if (workItemId && id !== workItemId) throw new Error("execution query returned a different work item");
        const match = /^([^:]+):(.+)#\d+$/.exec(id)!;
        const projectKey = match[2];
        return parseExecutionSummary({
          ...candidate,
          project: { platform: match[1], projectKey, name: projectKey.split("/").at(-1) ?? projectKey },
        });
      });
      return {
        executions,
        ...(page.nextCursor === undefined ? {} : { nextCursor: parseRequiredString(page.nextCursor, "execution cursor") }),
      };
    },
  };
}
