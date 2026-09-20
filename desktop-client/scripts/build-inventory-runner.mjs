import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const outputDirectory = path.join(repositoryRoot, "desktop-client/dist-electron/cli");

await mkdir(outputDirectory, { recursive: true });
await build({
  stdin: {
    contents: `
      import { createGlobalWorkItemCatalogs } from "./src/application/tracker-provider-factory.ts";
      import { collectGlobalWorkItemInventory, filterGlobalWorkItemInventory } from "./src/application/work-items/inventory.ts";

      exports.runInventory = async function runInventory(options = {}) {
        const platform = options.platform ?? "all";
        const result = await collectGlobalWorkItemInventory(createGlobalWorkItemCatalogs(platform));
        return filterGlobalWorkItemInventory(result, {
          state: options.state,
          mode: options.executionMode,
          tag: options.tag,
          project: options.project,
        });
      };
    `,
    resolveDir: repositoryRoot,
    sourcefile: "desktop-inventory-runner.ts",
    loader: "ts",
  },
  outfile: path.join(outputDirectory, "inventory-runner.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  logLevel: "warning",
});
