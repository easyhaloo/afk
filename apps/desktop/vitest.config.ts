import { defineConfig } from "vitest/config";

export default defineConfig({
  // electron/preload.cts is TypeScript that must compile to CommonJS (Electron
  // requires sandboxed preloads to be CJS). Vite's default esbuild include
  // pattern does not cover .cts, so it would be parsed as plain JavaScript.
  esbuild: { include: /\.(m?[jt]s|[cm]?tsx?)$/ },
  test: {
    environment: "node",
    setupFiles: ["../../scripts/test-home.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["tests/e2e/**", "node_modules/**", "dist/**"],
    fileParallelism: false,
  },
});
