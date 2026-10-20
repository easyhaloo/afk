import { defineConfig } from "vitest/config";

export default defineConfig({
  // electron/ and shared/ hold TypeScript that must compile to CommonJS
  // (Electron requires sandboxed preloads to be CJS) or that resolves
  // NodeNext-style `.js` specifiers. Vite's default esbuild include pattern
  // does not cover .cts/.mts, so it would parse them as plain JavaScript.
  esbuild: { include: /\.(m?[jt]s|[cm]?tsx?)$/ },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["tests/e2e/**", "node_modules/**", "dist/**"],
    fileParallelism: false,
  },
});
