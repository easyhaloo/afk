import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Repository contract: AFK writes every log under one root, `~/.afk/logs`.
 *
 * The watchdog used to write into `~/.claude/logs/afk` — Claude Code's own
 * home tree — because that path was hardcoded before the unified logger
 * existed and the later refactor never touched it. These rules fail the
 * build if a second log root creeps back in.
 */

const repoRoot = resolve(process.cwd());
const sourceRoots = ['packages', 'apps'];
const logPathsModule = 'packages/runtime/src/infrastructure/io/log-paths.ts';
const logPathsTest = 'packages/runtime/src/infrastructure/io/log-paths.test.ts';
const skippedDirectories = new Set(['node_modules', 'dist', 'build', '.dev', 'coverage']);

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skippedDirectories.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
        files.push(full);
      }
    }
  };
  for (const root of sourceRoots) walk(join(repoRoot, root));
  return files;
}

const files = sourceFiles().map(file => ({
  file: relative(repoRoot, file),
  contents: readFileSync(file, 'utf8'),
}));

describe('log path contract', () => {
  it('never writes logs into the Claude Code home tree', () => {
    const offenders = files
      .filter(({ contents }) => /\.claude\/logs|\.claude['"]\s*,\s*['"]logs/.test(contents))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('defines the log root in exactly one place', () => {
    const offenders = files
      .filter(({ file, contents }) => file !== logPathsModule && file !== logPathsTest && /'\.afk',\s*'logs'/.test(contents))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('builds log destinations from the log root, never from process.env.HOME', () => {
    // Test files may juggle HOME and AFK_LOG_DIR freely — only production
    // code is held to the rule.
    const offenders = files
      .filter(({ file, contents }) => !file.endsWith('.test.ts') && /logDir|logPath|LogDir|LogPath|LOG_DIR/.test(contents) && /process\.env\.HOME/.test(contents))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
