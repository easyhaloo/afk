import { describe, expect, it } from 'vitest';
import { isGeneratedOutputPath } from '../scripts/doc-source-paths.mjs';

describe('the document source-path rule', () => {
  it('does not demand an artifact that only a build produces', () => {
    // The desktop's bundle and the CLI's bundle are named in the documents
    // on purpose. Neither exists in a clean checkout, so demanding them
    // would fail the check on exactly the tree that needs checking.
    expect(isGeneratedOutputPath('dist-electron/electron/main.js')).toBe(true);
    expect(isGeneratedOutputPath('desktop-client/dist-electron/electron/preload.cjs')).toBe(true);
    expect(isGeneratedOutputPath('dist/index.js')).toBe(true);
    expect(isGeneratedOutputPath('release/app.js')).toBe(true);
  });

  it('still demands a source file', () => {
    expect(isGeneratedOutputPath('packages/afk-core/src/events.ts')).toBe(false);
    expect(isGeneratedOutputPath('src/cli/entry.ts')).toBe(false);
    expect(isGeneratedOutputPath('desktop-client/shared/ipc-contract.ts')).toBe(false);
    // A directory that merely resembles a generated one is still source.
    expect(isGeneratedOutputPath('src/distribution/index.ts')).toBe(false);
  });
});
