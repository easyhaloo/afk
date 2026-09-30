import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const guard = resolve('scripts/architecture-guard.mjs');
const directories: string[] = [];

const stateMapping = `const workStateByBacklogState = {
  ready: 'ready',
  rework: 'rework',
  in_progress: 'implementing',
  verification: 'verifying',
  merge_ready: 'merge_ready',
  done: 'done',
  blocked: 'blocked',
};
`;

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function write(root: string, filename: string, contents: string) {
  mkdirSync(resolve(root, filename, '..'), { recursive: true });
  writeFileSync(resolve(root, filename), contents);
}

function stateMappingFixture({ files, legacyFiles = [], legacyStateMappings = {} }: {
  files: Record<string, string>;
  legacyFiles?: string[];
  legacyStateMappings?: Record<string, number>;
}) {
  const directory = mkdtempSync(join(tmpdir(), 'afk-architecture-state-mapping-'));
  directories.push(directory);
  const root = join(directory, 'src');
  const desktopRoot = join(directory, 'desktop-client');
  mkdirSync(root, { recursive: true });
  for (const [filename, contents] of Object.entries(files)) {
    write(root, filename, contents);
  }
  const baseline = join(directory, 'baseline.json');
  writeFileSync(baseline, JSON.stringify({ legacyFiles, legacyImports: {}, legacyPatterns: {}, legacyStateMappings }));

  const run = () => {
    try {
      return execFileSync(
        process.execPath,
        [guard, '--root', root, '--baseline', baseline, '--desktop-client-root', desktopRoot],
        { encoding: 'utf8' },
      );
    } catch (error) {
      return (error as { stderr: Buffer }).stderr.toString();
    }
  };
  return { run, root, desktopRoot };
}

describe('architecture guard duplicate state mapping', () => {
  it('rejects the same backlog->core state mapping declared in two files', () => {
    const result = stateMappingFixture({
      files: { 'application/backlog-work-item.ts': stateMapping, 'shared/core-work-item-adapter.ts': stateMapping },
    });
    const output = result.run();
    expect(output).toContain('duplicate backlog->core state mapping');
    expect(output).toContain('application/backlog-work-item.ts');
    expect(output).toContain('shared/core-work-item-adapter.ts');
    expect(output).toContain('define it once and import it');
  });

  it('accepts a single backlog->core state mapping', () => {
    const result = stateMappingFixture({ files: { 'application/backlog-work-item.ts': stateMapping } });
    expect(result.run()).toContain('Architecture guard passed');
  });

  it('rejects a third copy in the desktop client source tree', () => {
    const result = stateMappingFixture({
      files: { 'application/backlog-work-item.ts': stateMapping, 'electron/adapters/core-work-item-adapter.ts': stateMapping },
    });
    const output = result.run();
    expect(output).toContain('duplicate backlog->core state mapping');
    expect(output).toContain('electron/adapters/core-work-item-adapter.ts');
  });

  it('reports a drifted copy whose values no longer match', () => {
    const drifted = stateMapping.replace("verification: 'verifying'", "verification: 'reviewing'");
    const result = stateMappingFixture({
      files: { 'application/backlog-work-item.ts': stateMapping, 'shared/core-work-item-adapter.ts': drifted },
    });
    expect(result.run()).toContain('duplicate backlog->core state mapping');
  });

  it('reports a repeated duplicate mapping only once', () => {
    const result = stateMappingFixture({
      files: {
        'application/backlog-work-item.ts': stateMapping,
        'shared/core-work-item-adapter.ts': stateMapping,
        'shared/second-copy.ts': stateMapping,
      },
    });
    const output = result.run();
    expect(output.match(/duplicate backlog->core state mapping/g)).toHaveLength(1);
    expect(output).toContain('shared/second-copy.ts');
  });

  it('accepts a backlog state enumeration list', () => {
    const result = stateMappingFixture({
      files: {
        'cli/commands/backlog.ts': "const states: BacklogState[] = ['ready', 'rework', 'in_progress', 'verification', 'merge_ready', 'done', 'blocked'];\nexport default states;\n",
        'shared/backlog-contract.ts': "export const BACKLOG_STATES = ['ready', 'rework', 'in_progress', 'verification', 'merge_ready', 'done', 'blocked'] as const;\n",
      },
    });
    expect(result.run()).toContain('Architecture guard passed');
  });

  it('accepts state label tables that map to labels instead of core states', () => {
    const result = stateMappingFixture({
      files: {
        'shared/backlog-labels.ts': "export const BACKLOG_STATE_LABELS: Record<string, string> = {\n  ready: '待处理',\n  rework: '返工中',\n  in_progress: '进行中',\n  verification: '验证中',\n  merge_ready: '待合并',\n  done: '已完成',\n  blocked: '阻塞',\n};\n",
        'shared/backlog-styles.ts': "export const stateStyles = {\n  ready: 'stage::ready-for-issues',\n  rework: 'stage::rework',\n  in_progress: 'stage::afk-in-progress',\n  verification: 'stage::qa',\n  merge_ready: 'stage::merge-ready',\n  done: 'stage::done',\n  blocked: 'stage::blocked',\n} satisfies Record<string, string>;\n",
      },
    });
    expect(result.run()).toContain('Architecture guard passed');
  });

  it('accepts a partial state mapping that is not the full canonical table', () => {
    const result = stateMappingFixture({
      files: {
        'shared/partial.ts': "export const terminalStates = {\n  done: 'done',\n  blocked: 'blocked',\n  cancelled: 'cancelled',\n} satisfies Record<string, string>;\n",
        'shared/other-partial.ts': "export const activeStates = {\n  in_progress: 'claimed',\n  verification: 'verifying',\n} satisfies Record<string, string>;\n",
      },
    });
    expect(result.run()).toContain('Architecture guard passed');
  });

  it('accepts an approved legacy duplicate pair but requires the baseline to shrink', () => {
    const files = { 'lib/legacy-a.ts': stateMapping, 'lib/legacy-b.ts': stateMapping };
    const legacyFiles = ['lib/legacy-a.ts', 'lib/legacy-b.ts'];
    const approved = stateMappingFixture({ files, legacyFiles, legacyStateMappings: { 'lib/legacy-a.ts, lib/legacy-b.ts': 2 } });
    expect(approved.run()).toContain('Architecture guard passed');

    const unapproved = stateMappingFixture({ files, legacyFiles });
    expect(unapproved.run()).toContain('unapproved legacy duplicate state mapping');

    const stale = stateMappingFixture({
      files: { 'lib/legacy-a.ts': stateMapping },
      legacyFiles: ['lib/legacy-a.ts'],
      legacyStateMappings: { 'lib/legacy-a.ts, lib/legacy-b.ts': 2 },
    });
    expect(stale.run()).toContain('stale legacy state mapping baseline');
  });

  it('ignores generated build output under the desktop client', () => {
    const directory = mkdtempSync(join(tmpdir(), 'afk-architecture-state-mapping-dist-'));
    directories.push(directory);
    const root = join(directory, 'src');
    const desktopRoot = join(directory, 'desktop-client');
    write(root, 'application/backlog-work-item.ts', stateMapping);
    write(desktopRoot, 'dist-electron/types/backlog-work-item.d.ts', stateMapping);
    const baseline = join(directory, 'baseline.json');
    writeFileSync(baseline, JSON.stringify({ legacyFiles: [], legacyImports: {}, legacyPatterns: {} }));

    const output = execFileSync(
      process.execPath,
      [guard, '--root', root, '--baseline', baseline, '--desktop-client-root', desktopRoot],
      { encoding: 'utf8' },
    );
    expect(output).toContain('Architecture guard passed');
  });
});
