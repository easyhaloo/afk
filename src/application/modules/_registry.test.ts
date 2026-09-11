import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, vi } from 'vitest';
import { parseModuleParams, resolveModuleNames } from './_registry';

describe('Module Registry', () => {
  it('reads modules from valid inline YAML', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'afk-modules-'));
    mkdirSync(join(directory, '.afk'));
    writeFileSync(join(directory, '.afk', 'config.yml'), 'workflow: { modules: [isolate] }\n');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(directory);
    try {
      await expect(resolveModuleNames()).resolves.toEqual(['isolate']);
    } finally {
      cwd.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  describe('parseModuleParams', () => {
    it('returns empty object for undefined input', () => {
      expect(parseModuleParams(undefined)).toEqual({});
    });

    it('returns empty object for empty array', () => {
      expect(parseModuleParams([])).toEqual({});
    });

    it('parses a single module param', () => {
      const result = parseModuleParams(['fork.auto=true']);
      expect(result).toEqual({ fork: { auto: 'true' } });
    });

    it('parses multiple params for the same module', () => {
      const result = parseModuleParams(['fork.auto=true', 'fork.ports=3406,6380']);
      expect(result).toEqual({ fork: { auto: 'true', ports: '3406,6380' } });
    });

    it('parses params for different modules', () => {
      const result = parseModuleParams(['fork.auto=true', 'mock-server.timeout=30']);
      expect(result).toEqual({
        fork: { auto: 'true' },
        'mock-server': { timeout: '30' },
      });
    });

    it('skips malformed params (no dot)', () => {
      const result = parseModuleParams(['invalid']);
      expect(result).toEqual({});
    });

    it('skips malformed params (no equals)', () => {
      const result = parseModuleParams(['module.key']);
      expect(result).toEqual({});
    });

    it('skips malformed params (empty value)', () => {
      const result = parseModuleParams(['module.=']);
      expect(result).toEqual({ module: { '': '' } });
    });
  });
});
