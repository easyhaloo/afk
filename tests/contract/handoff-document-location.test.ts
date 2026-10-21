import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AFK_HANDOFF_DIRECTORY } from "@afk/core";
import { handoffDocPath } from "@afk/execution/application/workflows/handoff";
import { HandoffSessionStore } from "@afk/execution/application/sessions/handoff-store";

/**
 * The runner writes the handoff document and the session store reads it
 * back as a fallback. The directory was spelled out in both - one of them
 * in pieces and the other as one string - so a directory that moved left
 * the recovery document written where the store did not look, and the
 * handoff was lost.
 *
 * The directory is named once now, in the layout, and the two sides read
 * it from there.
 */
/** The code of a file, without its comments: a comment may name a path
 *  for the reader, but it does not decide where anything lives. */
function codeOf(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

const NAMED_ELSEWHERE = [
  "packages/afk-execution/src/application/workflows/handoff.ts",
  "packages/afk-execution/src/application/sessions/handoff-store.ts",
];

describe("where the handoff document lives", () => {
  it("is where the runner writes it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "afk-handoff-"));
    const docPath = handoffDocPath(root, "42", 1);
    expect(path.dirname(docPath)).toBe(path.join(root, AFK_HANDOFF_DIRECTORY));
  });

  it("is where the session store looks for it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "afk-handoff-store-"));
    const directory = path.join(root, AFK_HANDOFF_DIRECTORY);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "handoff-42-1.md"), "# handoff\n", "utf8");

    const store = new HandoffSessionStore(root);
    const snapshot = await store.load({ runId: "issue-42-gen-1" });
    expect(snapshot.summary).toContain("handoff");
  });

  it("is not spelled out apart from the layout's own name", () => {
    // One directory: the layout's. A second spelling is a second
    // answer, and the writer and the reader act on different answers.
    for (const source of NAMED_ELSEWHERE) {
      const text = codeOf(path.join(process.cwd(), source));
      expect(text).not.toMatch(/'\.afk',\s*'handoff'|\.afk\/handoff/);
    }
  });
});
