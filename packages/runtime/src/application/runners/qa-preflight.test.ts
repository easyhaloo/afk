import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runQaPreflight } from './qa-preflight.js';

describe('QA preflight', () => {
  it('blocks when the machine cannot run a criterion its check command needs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'afk-preflight-'));
    const description = [
      '## Acceptance Criteria',
      '',
      '- [ ] 收件箱在某些条件下不能为空 -- test -- afk-tool-that-does-not-exist run',
      '',
    ].join('\n');

    const outcome = await runQaPreflight({ description }, cwd);

    expect(outcome.blocked).toBe(true);
    expect(outcome.summary).toContain('afk-tool-that-does-not-exist');
    expect(outcome.summary).toContain('收件箱在某些条件下不能为空');
    expect(outcome.blockers[0]).toMatchObject({ kind: 'tool_missing' });
  });

  it('lets a round start when every tool is there', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'afk-preflight-'));
    const description = [
      '## Acceptance Criteria',
      '',
      '- [ ] 版本号可读 -- none -- git --version',
      '',
    ].join('\n');

    const outcome = await runQaPreflight({ description }, cwd);

    expect(outcome.blocked).toBe(false);
    expect(outcome.summary).toBeUndefined();
  });

  it('needs no probe when the criteria name no command', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'afk-preflight-'));
    const description = [
      '## Acceptance Criteria',
      '',
      '- [ ] 反代路径形态待 U4 拍板 -- manual',
      '- [ ] 心跳只产生告警 -- manual -- echo manual review needed',
      '',
    ].join('\n');

    const outcome = await runQaPreflight({ description }, cwd);

    expect(outcome.blocked).toBe(false);
    expect(outcome.blockers).toHaveLength(0);
  });

  it('needs no probe for an item without acceptance criteria', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'afk-preflight-'));
    const outcome = await runQaPreflight({ description: '## Context\n\nno criteria here' }, cwd);

    expect(outcome.blocked).toBe(false);
  });
});
