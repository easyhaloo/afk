import { defineConfig } from "vitest/config";

export default defineConfig({
  // electron/ and shared/ hold TypeScript that must compile to CommonJS
  // (Electron requires sandboxed preloads to be CJS) or that resolves
  // NodeNext-style `.js` specifiers. Vite's default esbuild include pattern
  // does not cover .cts/.mts, so it would parse them as plain JavaScript.
  esbuild: { include: /\.(m?[jt]s|[cm]?tsx?)$/ },
  test: {
    environment: "node",
    // The runtime registry is a file under the user's home. Point it
    // somewhere disposable for the whole run, so no test can write into
    // the developer's machine by forgetting to.
    setupFiles: ["../tests/setup-runtime-registry.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["tests/e2e/**", "node_modules/**", "dist/**"],
    fileParallelism: false,
    // The same ceiling for a test and for its setup: the files here render
    // React and ink, and a loaded machine can push a legitimate render past
    // the default five seconds. The ceiling only applies when a test
    // actually hangs.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
