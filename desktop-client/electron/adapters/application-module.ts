import { basename, join } from "node:path";
import type * as Application from "@afk/application";

export function loadApplication(): typeof Application {
  const root = join(__dirname, "..", "..");
  const bundle = join(root, basename(root) === "dist-electron" ? "" : "dist-electron", "application.cjs");
  return require(bundle) as typeof Application;
}
