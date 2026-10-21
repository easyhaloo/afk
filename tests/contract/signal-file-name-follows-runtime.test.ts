import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SIGNAL_FILE } from "@afk/infrastructure";
import { buildInteractivePrompt } from "@afk/execution/application/workflows/execution-protocol";

/**
 * The interactive prompt tells the agent where to write the completion
 * signal, and the runtime reads the signal from the file it names. The
 * name was written down three times - in the prompt, in the runtime and
 * in the list of files AFK keeps out of the user's commits - and a name
 * that moved left the agent writing a file nobody was watching: the run
 * waited for a signal that was never going to arrive, and the signal
 * file turned up in the user's branch.
 *
 * The name is written once now, in the runtime. The prompt and the
 * exclude list read it from there.
 */
const NAMED_ELSEWHERE = [
  "packages/afk-execution/src/application/workflows/execution-protocol.ts",
  "packages/afk-infrastructure/src/git/repo-exclude.ts",
];

describe("the completion signal the interactive prompt asks for", () => {
  it("is the file the runtime reads", () => {
    const prompt = buildInteractivePrompt("do the work");
    expect(prompt).toContain(SIGNAL_FILE);
  });

  it("is not named apart from the runtime's own name", () => {
    // One name: the runtime's. A second spelling is a second answer, and
    // the two answers are what the agent and the runtime act on.
    for (const source of NAMED_ELSEWHERE) {
      const text = readFileSync(join(process.cwd(), source), "utf8");
      expect(text).not.toMatch(/\.afk-signal\.json/);
    }
  });
});
