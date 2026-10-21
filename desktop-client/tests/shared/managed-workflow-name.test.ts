import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MANAGED_WORKFLOW_TEMPLATE_NAME } from "../../shared/ipc-contract";

function sourcesIn(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...sourcesIn(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

describe("the managed workflow template", () => {
  it("is named once in the desktop", () => {
    // The desktop writes this template under this name, edits it under
    // this name and shows it under this name. The name was written in
    // seven places across two files, so a change to it left the desktop
    // unable to find the template it had just written. One place is the
    // name; another is a copy.
    const spellings = sourcesIn(join(process.cwd(), 'electron'))
      .concat(sourcesIn(join(process.cwd(), 'src')))
      .concat(sourcesIn(join(process.cwd(), 'shared')))
      .flatMap(file => [...readFileSync(file, 'utf8').matchAll(/"afk-control-workflow"/g)].map(() => file));
    expect(spellings).toHaveLength(1);
  });

  it("is the name the desktop uses", () => {
    expect(MANAGED_WORKFLOW_TEMPLATE_NAME).toBe("afk-control-workflow");
  });
});
