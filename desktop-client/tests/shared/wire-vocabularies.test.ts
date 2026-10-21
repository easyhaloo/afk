import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunOutcome, WorkflowStepKind } from "@afk/core";
import type { DiagnosticSeverity } from "@afk/workflow-graph";

/**
 * The desktop's wire contract described three vocabularies the rest of
 * the product already owns: how a run ended, what kind a workflow step
 * is, and how severe a graph diagnostic is. It spelled each of them out
 * again, so a vocabulary that grew on its owner did not grow here, and
 * the desktop refused a payload the product had already learned to send.
 */
const NAMED_ELSEWHERE = [
  "shared/execution-contract.ts",
  "shared/ipc-contract.ts",
];

describe("the desktop's wire vocabularies", () => {
  it("are the ones their owners publish", () => {
    // The owners' types accept what the desktop's types accept, and the
    // other way round: one vocabulary, two names.
    const outcome: RunOutcome = "succeeded";
    const kind: WorkflowStepKind = "agent";
    const severity: DiagnosticSeverity = "warning";
    expect([outcome, kind, severity]).toEqual(["succeeded", "agent", "warning"]);
  });

  it("are not spelled out again where the desktop renders them", () => {
    for (const source of NAMED_ELSEWHERE) {
      const text = readFileSync(join(process.cwd(), source), "utf8");
      expect(text).not.toMatch(/"succeeded" \| "failed" \| "cancelled"/);
      expect(text).not.toMatch(/"agent" \| "system"/);
      expect(text).not.toMatch(/"info" \| "warning" \| "error"/);
    }
  });
});
