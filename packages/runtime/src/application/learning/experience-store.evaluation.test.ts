import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ExperienceStore } from './experience-store.js';

const scope = 'github:owner/wiki';
const lessons = [
  {
    name: 'database-lock', trigger: '数据库写入锁定', rootCause: '并发事务竞争写入锁',
    action: '串行执行写入事务并设置繁忙等待时间',
    queries: ['数据库被锁定时怎样恢复写入？', '写入数据库时遇到锁定，请帮助恢复。'],
  },
  {
    name: 'cache-expiry', trigger: '缓存条目过期', rootCause: '读取路径没有检查过期时间',
    action: '读取时清除过期条目并重新加载数据',
    queries: ['缓存条目过期后仍然读到旧值怎么办？', '条目已经过期，缓存为何没有清除？'],
  },
  {
    name: 'cancellation', trigger: '任务取消后资源泄漏', rootCause: '取消分支跳过清理步骤',
    action: '取消后关闭句柄并释放资源',
    queries: ['如何清理取消任务后泄漏的资源？', '资源在任务取消以后没有释放，应该怎样清理？'],
  },
  {
    name: 'queue-capacity', trigger: '队列容量不足', rootCause: '生产速度超过消费速度',
    action: '队列满时暂停生产直到消费者释放容量',
    queries: ['队列满了，生产速度超过消费速度怎么办？', '消费者来不及处理，怎样限制队列容量？'],
  },
  {
    name: 'permission', trigger: '权限校验失败', rootCause: '授权凭据缺少项目读取权限',
    action: '为凭据授予项目读取权限后重试校验',
    queries: ['项目读取权限缺失导致校验失败，怎样处理？', '凭据没有读取权限，项目授权应该如何修复？'],
  },
  {
    name: 'connection-timeout', trigger: '连接超时', rootCause: '连接池耗尽且等待没有上限',
    action: '设置连接等待上限并释放空闲连接',
    queries: ['连接池耗尽以后请求超时，应该怎样恢复？', '请求等待连接超时，需要释放空闲连接吗？'],
  },
  {
    name: 'sqlite-busy', trigger: 'SQLITE_BUSY during transaction commit', rootCause: 'A writer holds the transaction open',
    action: 'Close the writer transaction before retrying the commit',
    queries: ['SQLITE_BUSY during transaction commit', '提交事务遇到SQLITE_BUSY，怎样关闭占用的写事务？'],
  },
  {
    name: 'connection-refused', trigger: 'ECONNREFUSED contacting the service', rootCause: 'The service listens on a different port',
    action: 'Correct the endpoint port and retry the connection',
    queries: ['ECONNREFUSED service endpoint port', '服务端口配置错误导致ECONNREFUSED，如何恢复连接？'],
  },
  {
    name: 'missing-module', trigger: 'ERR_MODULE_NOT_FOUND loading the package', rootCause: 'The package export references an absent build artifact',
    action: 'Build the workspace package before importing its export',
    queries: ['ERR_MODULE_NOT_FOUND package export build artifact', '导入工作区包遇到ERR_MODULE_NOT_FOUND，是否需要先构建？'],
  },
  {
    name: 'implementation-command', trigger: 'afk-do stops before implementation', rootCause: 'The backlog item has no approved requirement',
    action: 'Approve the requirement before running afk-do again',
    queries: ['afk-do stops before implementation', '需求批准后如何重新运行afk-do？'],
  },
  {
    name: 'qa-command', trigger: 'afk-qa cannot open the review', rootCause: 'The review reference points to a stale branch',
    action: 'Refresh the review reference and rerun afk-qa',
    queries: ['afk-qa stale review branch', '评审引用过期时怎样重新执行afk-qa？'],
  },
  {
    name: 'sqlite-version', trigger: 'SQLite 3.45 WAL checkpoint stalls', rootCause: 'A long reader prevents checkpoint progress in SQLite 3.45',
    action: 'Finish the long reader before retrying the WAL checkpoint; validated only on SQLite 3.45',
    queries: ['SQLite 3.45 WAL checkpoint stalls with a long reader', 'SQLite 3.45 的 WAL checkpoint 被长读事务阻塞，如何恢复？'],
  },
] as const;

const negatives = [
  { name: 'other-project', scope: 'github:owner/payments', prompt: 'Fix SQLITE_BUSY during transaction commit in payments.' },
  { name: 'other-owner', scope: 'github:other/wiki', prompt: '另一个组织的服务出现 ECONNREFUSED，请修复端口。' },
  { name: 'other-platform', scope: 'gitlab:owner/wiki', prompt: 'afk-do stops before implementation in GitLab.' },
  { name: 'scope-prefix', scope: 'github:owner/wiki-tools', prompt: 'SQLite 3.45 WAL checkpoint stalls in wiki-tools.' },
  { name: 'foreign-record', scope, prompt: 'FOREIGN_ONLY_ERROR' },
  { name: 'different-error-code', scope, prompt: 'SQLITE_LOCKED_SHAREDCACHE' },
  { name: 'different-cli-command', scope, prompt: 'afk-plan' },
  { name: 'different-cli-suffix', scope, prompt: 'afk-doctor' },
  { name: 'unrelated-english', scope, prompt: 'Render watercolor wallpaper' },
  { name: 'unrelated-chinese', scope, prompt: '绘制水彩插画' },
  { name: 'candidate', scope, prompt: 'CANDIDATE_ONLY_ERROR' },
  { name: 'expired', scope, prompt: 'EXPIRED_ONLY_ERROR' },
  { name: 'revoked', scope, prompt: 'REVOKED_ONLY_ERROR' },
  { name: 'opposite-chinese', scope, prompt: '任务没有取消，也没有资源泄漏；只调整界面颜色。', contextLimit: 'negation' },
  { name: 'opposite-english', scope, prompt: 'ECONNREFUSED is absent; the connection works. Only rename a heading.', contextLimit: 'negation' },
  { name: 'other-version-english', scope, prompt: 'SQLite 3.46 WAL checkpoint stalls; only use corrections verified for 3.46.', contextLimit: 'version' },
  { name: 'other-version-chinese', scope, prompt: 'SQLite 3.46 已升级，不采用 3.45 checkpoint 修复。', contextLimit: 'version' },
  { name: 'project-only-in-prompt', scope, prompt: 'Fix SQLITE_BUSY only in github:other/payments; github:owner/wiki must remain unchanged.', contextLimit: 'prompt project' },
] as const;

const sqliteTarget = { project: scope, dirty: false, productVersions: { sqlite: '3.45' } };
const negativeTargets = new Map([
  ['other-version-english', { ...sqliteTarget, revision: 'b'.repeat(40), productVersions: { sqlite: '3.46' } }],
  ['other-version-chinese', { ...sqliteTarget, revision: 'b'.repeat(40), productVersions: { sqlite: '3.46' } }],
]);

it('measures the frozen twelve query pairs and eighteen inapplicable queries at five', () => {
  const directory = mkdtempSync(join(tmpdir(), 'experience-recall-evaluation-'));
  let now = new Date('2026-11-08T10:00:00.000Z');
  const store = new ExperienceStore({ file: join(directory, 'experience.sqlite'), now: () => now });
  try {
    function record(name: string, trigger: string, rootCause: string, action: string, targetScope = scope, expiresAt?: string) {
      return store.recordFailure({ scope: targetScope, trigger, rootCause, action, expiresAt,
        source: { runId: `failure-${name}`, workItemId: `${targetScope}#42` }, evidence: [`evidence://${name}/failure`] });
    }
    function verify(id: string, name: string, targetScope = scope) {
      const context = name === 'sqlite-version' || name === 'foreign-sqlite-version'
        ? { target: { ...sqliteTarget, project: targetScope } } : undefined;
      store.verify(id, { runId: `qa-${name}`, evidence: [`evidence://${name}/passed`] }, context);
    }
    const expected = new Map<string, string>();
    for (const lesson of lessons) {
      const entry = record(lesson.name, lesson.trigger, lesson.rootCause, lesson.action);
      expected.set(lesson.name, entry.id);
      verify(entry.id, lesson.name);
      const foreign = record(`foreign-${lesson.name}`, lesson.trigger, lesson.rootCause, lesson.action, 'github:other/decoy');
      verify(foreign.id, `foreign-${lesson.name}`, 'github:other/decoy');
    }
    const foreign = record('foreign-only', 'FOREIGN_ONLY_ERROR', 'Foreign failure', 'Foreign correction', 'github:other/decoy');
    verify(foreign.id, 'foreign-only');
    record('candidate-only', 'CANDIDATE_ONLY_ERROR', 'Unverified failure', 'Unverified correction');
    const expired = record('expired-only', 'EXPIRED_ONLY_ERROR', 'Expired failure', 'Expired correction', scope, '2026-11-09T10:00:00.000Z');
    verify(expired.id, 'expired-only');
    const revoked = record('revoked-only', 'REVOKED_ONLY_ERROR', 'Revoked failure', 'Revoked correction');
    verify(revoked.id, 'revoked-only');
    store.revoke(revoked.id);
    now = new Date('2026-11-09T10:00:00.000Z');

    const misses: string[] = [];
    const scopeLeaks: string[] = [];
    const negativeHits: { name: string; lessons: string[]; contextLimit?: string }[] = [];
    let hits = 0;
    let completePairs = 0;
    for (const lesson of lessons) {
      let pairHits = 0;
      for (const prompt of lesson.queries) {
        const target = lesson.name === 'sqlite-version' ? { ...sqliteTarget, revision: 'b'.repeat(40) } : undefined;
        const recalled = store.recall({ scope, prompt, limit: 5, target });
        if (recalled.some(entry => entry.scope !== scope)) scopeLeaks.push(prompt);
        if (recalled.some(entry => entry.id === expected.get(lesson.name))) { hits++; pairHits++; }
        else misses.push(`${lesson.name}: ${prompt}`);
      }
      if (pairHits === 2) completePairs++;
    }
    for (const query of negatives) {
      const recalled = store.recall({ scope: query.scope, prompt: query.prompt, limit: 5, target: negativeTargets.get(query.name) });
      if (recalled.some(entry => entry.scope !== query.scope)) scopeLeaks.push(query.name);
      if (recalled.length) negativeHits.push({ name: query.name,
        lessons: recalled.map(entry => [...expected].find(([, id]) => id === entry.id)?.[0] ?? entry.trigger),
        contextLimit: 'contextLimit' in query ? query.contextLimit : undefined });
    }
    console.log(JSON.stringify({ queries: 24, hits, recallAt5: hits / 24, completePairs,
      negatives: negatives.length, falsePositiveQueries: negativeHits.length,
      negativeRejectionRate: (negatives.length - negativeHits.length) / negatives.length,
      scopeLeaks, misses, negativeHits }, null, 2));
    expect.soft(scopeLeaks).toEqual([]);
    expect.soft(misses).toEqual([]);
    expect.soft(negativeHits).toEqual([]);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
