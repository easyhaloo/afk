import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflowConfig, repositoryExecutionDefaults } from './manager.js';

describe('repository execution configuration', () => {
  it('isolates repository overrides and gives local project facts precedence without changing global defaults', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-repository-config-'));
    try {
      await mkdir(join(root, '.afk'));
      await writeFile(join(root, '.afk', 'config.yml'), 'defaultBaseRef: main\nrepositories:\n  team/api:\n    baseRef: release\n    targetRef: production\n  team/web:\n    baseRef: staging\n');
      const config = loadWorkflowConfig(root, {});
      expect(repositoryExecutionDefaults(config, 'team/api')).toEqual({ baseRef: 'release', targetRef: 'production' });
      expect(repositoryExecutionDefaults(config, 'team/web')).toEqual({ baseRef: 'staging', targetRef: 'staging' });
      await writeFile(join(root, '.afk', 'project.yml'), 'baseRef: project-release\nsourceRef: migration\n');
      expect(repositoryExecutionDefaults(config, 'team/api', root)).toEqual({ baseRef: 'project-release', targetRef: 'production', sourceRef: 'migration' });
      expect(config.defaultBaseRef).toBe('main');
      expect(repositoryExecutionDefaults(config, 'unconfigured/repo')).toEqual({ baseRef: 'main', targetRef: 'main' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('maps legacy branch settings to the default and validates overrides', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-repository-config-'));
    try {
      expect(loadWorkflowConfig(root, { AFK_TARGET_BRANCH: 'legacy' }).defaultBaseRef).toBe('legacy');
      await mkdir(join(root, '.afk'));
      await writeFile(join(root, '.afk', 'config.yml'), 'repositories:\n  team/api:\n    baseRef: ../unsafe\n');
      expect(() => loadWorkflowConfig(root, {})).toThrow('team/api.baseRef');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
