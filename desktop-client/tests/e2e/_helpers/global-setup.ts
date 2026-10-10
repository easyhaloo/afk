import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function globalSetup() {
  execFileSync("pnpm", ["build:main"], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    stdio: "inherit",
  });
}
