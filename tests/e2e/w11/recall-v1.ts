import assert from 'node:assert/strict';
import type { ContextQuery } from '@afk/runtime/plugin-sdk';

const project = 'github:w11/parcel';
const otherProject = 'github:w11/parcel-archive';

export const protocol = {
  version: 'w11-recall-v1',
  corpus: 'Use an isolated profile per case. Only the named asset family exists. Bind its logical key and edition to actual publication or installation receipts before querying.',
  baseline: 'The source in github:w11/parcel describes parcel 2.0 in staging. Edition 2 supersedes edition 1. Apply the case state to this baseline before starting a fresh consumer task.',
  installed: 'Use an installation outside the checkout. Retain the real Claude extraction, validation, publication (or human merge and installation), state change, build and fresh second-agent run receipts.',
  observe: 'Pass only query to the consumer with target and applicability supplied by trusted task configuration. Resolve every returned origin to its actual scope, logical key and edition via receipts. Keep the original order.',
  unavailable: 'Record a blocked case if setup, consumer, identity mapping or observation is unavailable. An empty list requires a successfully observed consumer response.',
  result: 'A fixture checks the oracle only. An installed recall observation measures retrieval. Adoption and the 18 benefit comparisons require separate runs.',
} as const;

const assets = {
  fact: { key: 'seal-cutoff', consumer: 'context.knowledge', source: '封签点（截单点）之后，包裹改址须转人工。' },
  process: { key: 'return-handoff', consumer: 'context.knowledge', source: '退件交接（逆向移交）先核对袋号，再登记签收。自提退件不走此路径。' },
  lesson: { key: 'label-offset', consumer: 'context.experience', source: '标签发生纵向偏移且走纸刻度错误时重新标定走纸。模板留白错误时不适用。' },
  skill: { key: 'reconcile-bags', consumer: 'installed agent skill discovery', source: '封袋对账（袋单核对）技能比对交接单和袋号，只读输出差异。' },
  tool: { key: 'scan-manifest', consumer: 'installed agent tool discovery', source: '清单验码（面单校验）工具只读检查扫描清单的校验位。' },
} as const;

const states = {
  active: 'Use the authorized published or installed edition 2.',
  conflict: 'Two current authorities disagree on the cutoff rule. Leave the conflict unresolved before querying.',
  expired: 'The source validity deadline has passed at query time.',
  withdrawn: 'Withdraw the publication, then start a new consumer process.',
  revoked: 'Revoke the source read grant after publication or installation.',
  missing: 'Use a clean profile with no editions of this family.',
  proposal: 'Keep only the proposed code change. No edition has been installed.',
  uninstalled: 'Remove the installed asset and start a new consumer process.',
} as const;

function row(id: string, kind: keyof typeof assets, state: keyof typeof states, prompt: string,
  expected: 'hit' | 'exclude', options: { scope?: string; version?: string; environment?: string; conditions?: Record<string, boolean> } = {}) {
  const scope = options.scope ?? project;
  const query: ContextQuery = { scope, prompt, limit: 5, applicability: { environment: options.environment ?? 'staging' },
    target: { project: scope, productVersions: { parcel: options.version ?? '2.0' }, conditions: options.conditions ?? {} } };
  return { id, kind, asset: { ...assets[kind], scope: project, edition: 2 }, state, setup: states[state], query, expected };
}

export const recallCases = [
  row('fact-01', 'fact', 'active', '封签点后怎样办理包裹改址？', 'hit'),
  row('fact-02', 'fact', 'active', '过了截单点还能直接改地址吗？', 'hit'),
  row('fact-03', 'fact', 'active', '封签点后怎样办理包裹改址？', 'exclude', { scope: otherProject }),
  row('fact-04', 'fact', 'active', '封签点后怎样办理包裹改址？', 'exclude', { version: '1.0' }),
  row('fact-05', 'fact', 'conflict', '封签点后怎样办理包裹改址？', 'exclude'),
  row('fact-06', 'fact', 'expired', '封签点后怎样办理包裹改址？', 'exclude'),
  row('process-01', 'process', 'active', '退件交接如何登记签收？', 'hit', { conditions: { pickup: false } }),
  row('process-02', 'process', 'active', '逆向移交先查袋号还是先签收？', 'hit', { conditions: { pickup: false } }),
  row('process-03', 'process', 'active', '自提退件需要走退件交接吗？', 'exclude', { conditions: { pickup: true } }),
  row('process-04', 'process', 'active', '退件交接如何登记签收？', 'exclude', { scope: otherProject, conditions: { pickup: false } }),
  row('process-05', 'process', 'revoked', '退件交接如何登记签收？', 'exclude', { conditions: { pickup: false } }),
  row('process-06', 'process', 'withdrawn', '退件交接如何登记签收？', 'exclude', { conditions: { pickup: false } }),
  row('lesson-01', 'lesson', 'active', '走纸刻度错误导致标签纵向偏移，怎样修复？', 'hit', { conditions: { feedDrift: true } }),
  row('lesson-02', 'lesson', 'active', '纸张步距失准，面单上下错位怎么恢复？', 'hit', { conditions: { feedDrift: true } }),
  row('lesson-03', 'lesson', 'active', '标签纵向偏移，但走纸正常，错误来自模板留白。', 'exclude', { conditions: { feedDrift: false } }),
  row('lesson-04', 'lesson', 'active', '走纸刻度错误导致标签纵向偏移，怎样修复？', 'exclude', { environment: 'production', conditions: { feedDrift: true } }),
  row('lesson-05', 'lesson', 'withdrawn', '走纸刻度错误导致标签纵向偏移，怎样修复？', 'exclude', { conditions: { feedDrift: true } }),
  row('lesson-06', 'lesson', 'missing', '走纸刻度错误导致标签纵向偏移，怎样修复？', 'exclude', { conditions: { feedDrift: true } }),
  row('skill-01', 'skill', 'active', '请用封袋对账技能列出交接单差异。', 'hit'),
  row('skill-02', 'skill', 'active', '有哪些技能能做袋单核对？', 'hit'),
  row('skill-03', 'skill', 'active', '请用封袋对账技能列出交接单差异。', 'exclude', { scope: otherProject }),
  row('skill-04', 'skill', 'active', '请用封袋对账技能列出交接单差异。', 'exclude', { version: '1.0' }),
  row('skill-05', 'skill', 'proposal', '请用封袋对账技能列出交接单差异。', 'exclude'),
  row('skill-06', 'skill', 'uninstalled', '请用封袋对账技能列出交接单差异。', 'exclude'),
  row('tool-01', 'tool', 'active', '用清单验码工具检查扫描清单。', 'hit'),
  row('tool-02', 'tool', 'active', '面单校验要用哪一个只读工具？', 'hit'),
  row('tool-03', 'tool', 'active', '用清单验码工具检查扫描清单。', 'exclude', { environment: 'production' }),
  row('tool-04', 'tool', 'revoked', '用清单验码工具检查扫描清单。', 'exclude'),
  row('tool-05', 'tool', 'proposal', '用清单验码工具检查扫描清单。', 'exclude'),
  row('tool-06', 'tool', 'uninstalled', '用清单验码工具检查扫描清单。', 'exclude'),
] as const;

type RecallCase = (typeof recallCases)[number];
type ReturnedAsset = { scope: string; key: string; edition: number };
type Observation = { caseId: string } & (
  | { status: 'observed'; ranked: readonly ReturnedAsset[] }
  | { status: 'blocked'; reason: string }
);

export function assertObservedRecall(entry: RecallCase, observation: Observation) {
  assert.equal(observation.caseId, entry.id, 'observation belongs to another case');
  if (observation.status === 'blocked') assert.fail(`${entry.id} blocked: ${observation.reason}`);
  assert.equal(observation.status, 'observed');
  const { scope, key, edition } = entry.asset;
  assert.deepEqual(observation.ranked, entry.expected === 'hit' ? [{ scope, key, edition }] : [], entry.id);
}
