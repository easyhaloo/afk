import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyProbeFailure, probeQaEnvironment } from './environment-probe.js';

describe('QA environment probe', () => {
  describe('failure classification', () => {
    it('reads a missing tool as a missing tool', () => {
      expect(classifyProbeFailure('command not found: mvn')).toMatchObject({ kind: 'tool_missing' });
      expect(classifyProbeFailure('bash: mvn: command not found')).toMatchObject({ kind: 'tool_missing' });
    });

    it('reads a missing dependency as a missing dependency', () => {
      expect(classifyProbeFailure("ModuleNotFoundError: No module named 'django'")).toMatchObject({ kind: 'dependency_missing' });
      expect(classifyProbeFailure("Cannot find module 'express'")).toMatchObject({ kind: 'dependency_missing' });
    });

    it('reads a missing runtime as a missing runtime', () => {
      expect(classifyProbeFailure('JAVA_HOME is not defined correctly')).toMatchObject({ kind: 'runtime_missing' });
      expect(classifyProbeFailure('Unable to locate a Java Runtime')).toMatchObject({ kind: 'runtime_missing' });
    });

    it('does not claim a failing test is an environment problem', () => {
      expect(classifyProbeFailure('Tests run: 3, Failures: 1, Errors: 0')).toBeNull();
      expect(classifyProbeFailure('AssertionError: expected 3 but got 4')).toBeNull();
      expect(classifyProbeFailure('BUILD FAILURE')).toBeNull();
    });
  });

  describe('probing', () => {
    it('reports a tool that is not installed', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'afk-probe-'));
      const result = await probeQaEnvironment(
        [{ tool: 'afk-tool-that-does-not-exist', criterion: 'a criterion', checkCommand: 'afk-tool-that-does-not-exist run' }],
        cwd,
      );

      expect(result.blockers).toHaveLength(1);
      expect(result.blockers[0]).toMatchObject({ tool: 'afk-tool-that-does-not-exist', kind: 'tool_missing' });
      expect(result.inconclusive).toHaveLength(0);
    });

    it('accepts a tool that works here', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'afk-probe-'));
      const result = await probeQaEnvironment(
        [{ tool: 'git', criterion: 'a criterion', checkCommand: 'git --version' }],
        cwd,
      );

      expect(result.blockers).toHaveLength(0);
      expect(result.inconclusive).toHaveLength(0);
    });

    it('probes a tool once even when several criteria need it', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'afk-probe-'));
      const result = await probeQaEnvironment(
        [
          { tool: 'afk-tool-that-does-not-exist', criterion: 'first', checkCommand: 'afk-tool-that-does-not-exist run' },
          { tool: 'afk-tool-that-does-not-exist', criterion: 'second', checkCommand: 'afk-tool-that-does-not-exist check' },
        ],
        cwd,
      );

      expect(result.blockers).toHaveLength(1);
      expect(result.blockers[0].criterion).toBe('first');
    });
  });
});
