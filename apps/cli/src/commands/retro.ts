import { workspaceDataDirectory } from '@afk/runtime/infrastructure/workspace';
import { createHash } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { z } from 'zod';
import type { AgentToolCallSummary, RunEvent } from '@afk/core';
import type { CommandRegistrationContext } from '../command-registry.js';
import { JsonlEventStore } from '@afk/runtime/infrastructure/observability/jsonl-event-store';
import { readAgentTelemetry, readAgentTools, findCodexRollout } from '@afk/runtime/infrastructure/observability/agent-telemetry';
import { defaultSessionStoreChain } from '@afk/runtime/application/sessions/chain';
import { claudeProjectSlug } from '@afk/runtime/shared/agent-transcript-path';
import { ClaudeCodeProvider } from '@afk/runtime/domain/agents/claude-code';
import { buildEvidencePack, saveEvidencePack, buildRetroPrompt, executeAnalysis,
  retroModelOutputSchema as modelOutputSchema, retroReportSchema as reportSchema,
  type EvidencePack, type EvidenceSourceInput } from '@afk/runtime/execution';

const RETRO_VERSION = '4';

type RetroReport = z.infer<typeof reportSchema>;
type Event = RunEvent;
const reportHtmlFile = 'report.html';

interface RetroOptions {
  runId: string;
  executionId: string;
  workItemId?: string;
  workspace: string;
  root?: string;
  provider: 'claude-code' | 'codex' | 'opencode';
  transcript?: string;
}

interface EvidenceFile {
  kind: string;
  path: string;
  uri: string;
  sha256: string;
  mediaType: string;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderRetroHtml(report: RetroReport): string {
  const metricLabels = {
    sessionCount: '会话数', toolCallCount: '工具调用数', failedToolCallCount: '失败工具调用',
    retryCount: '重试次数', checkFailureCount: '检查失败数', missingEvidenceCount: '缺失证据数',
  };
  const categoryLabels = {
    navigation: '导航', automated_checks: '自动化检查', coding_standards: '编码规范',
    global_instructions: '全局指令', tool_economy: '工具效率', no_ops: '无效操作', information_access: '信息访问',
  };
  const severityLabels = { low: '低', medium: '中', high: '高' } as const;
  const sourceLabels = { final: '最终报告', provisional: '阶段性报告', failure: '分析失败' } as const;
  const sessionSourceLabels = { transcript_found: '已记录', transcript_missing: '缺失', transcript_unindexed: '未索引兼容发现' } as const;
  const metrics = Object.entries(report.metrics).map(([key, value]) => `<div class="metric"><span>${escapeHtml(metricLabels[key as keyof typeof metricLabels] ?? key)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  const findings = report.findings.map(finding => `
    <article class="finding ${escapeHtml(finding.severity)}">
      <div class="finding-head"><span class="badge">${escapeHtml(severityLabels[finding.severity])}</span><span class="category">${escapeHtml(categoryLabels[finding.category])}</span></div>
      <h2>${escapeHtml(finding.title)}</h2>
      <p>${escapeHtml(finding.recommendation)}</p>
      <details><summary>根因与证据</summary><p>${escapeHtml(finding.rootCause)}</p><ul>${finding.evidence.map(item => `<li><code>${escapeHtml(item)}</code></li>`).join('')}</ul></details>
    </article>`).join('');
  const evidence = report.evidence.map(item => `<li><code>${escapeHtml(item)}</code></li>`).join('');
  const sessions = (report.sessions ?? []).map(session => `<li><strong>${escapeHtml(sessionSourceLabels[session.source])}</strong> <code>${escapeHtml(session.sessionId)}</code>${session.transcriptPath ? ` <code>${escapeHtml(session.transcriptPath)}</code>` : ''}</li>`).join('');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AFK 复盘报告 · ${escapeHtml(report.workItemId)}</title>
<style>
:root{color-scheme:dark;--bg:#111318;--panel:#1a1d24;--line:#303641;--text:#eef1f5;--muted:#aab2bf;--accent:#8bd5ca;--warn:#f0bd74;--danger:#f28b82}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1080px;margin:0 auto;padding:48px 28px 72px}header{border-bottom:1px solid var(--line);padding-bottom:28px;margin-bottom:24px}h1{font-size:32px;letter-spacing:-.03em;margin:0 0 8px}h2{font-size:19px;margin:10px 0}p{margin:8px 0;color:var(--muted)}.meta{display:flex;flex-wrap:wrap;gap:8px 18px;color:var(--muted);font-size:13px}.status{display:inline-block;border:1px solid var(--accent);color:var(--accent);border-radius:999px;padding:2px 10px;text-transform:uppercase;font-size:12px;font-weight:700}.summary,.metrics,.finding,.evidence,.sessions{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px;margin:16px 0}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.metric{border-right:1px solid var(--line);padding:4px 12px}.metric:last-child{border-right:0}.metric span{display:block;color:var(--muted);font-size:12px}.metric strong{display:block;font-size:24px;margin-top:4px}.finding{border-left:4px solid var(--accent)}.finding.medium{border-left-color:var(--warn)}.finding.high{border-left-color:var(--danger)}.finding-head{display:flex;gap:10px;align-items:center;color:var(--muted);font-size:12px;text-transform:uppercase}.badge{color:var(--text);font-weight:700}.category{font-family:ui-monospace,SFMono-Regular,monospace}code{color:var(--accent);overflow-wrap:anywhere}summary{cursor:pointer;color:var(--text)}ul{padding-left:22px;color:var(--muted)}.section-title{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.12em;margin:28px 0 10px}@media(max-width:640px){main{padding:28px 16px}.metric{border-right:0;border-bottom:1px solid var(--line);padding:8px 0}.metric:last-child{border-bottom:0}}
</style></head><body><main>
<header><span class="status">${escapeHtml(sourceLabels[report.source])}</span><h1>AFK 复盘报告</h1><div class="meta"><span>工作项：${escapeHtml(report.workItemId)}</span><span>运行：${escapeHtml(report.runId)}</span><span>生成时间：${escapeHtml(report.generatedAt)}</span></div></header>
<div class="section-title">摘要</div><section class="summary"><p>${escapeHtml(report.summary)}</p></section>
<div class="section-title">执行指标</div><section class="metrics">${metrics}</section>
<div class="section-title">会话证据</div><section class="sessions"><ul>${sessions || '<li>没有会话证据。</li>'}</ul></section>
<div class="section-title">发现项（${report.findings.length}）</div>${findings || '<section class="finding"><p>没有发现可记录的问题。</p></section>'}
<div class="section-title">证据引用</div><section class="evidence"><ul>${evidence || '<li>没有证据引用。</li>'}</ul></section>
</main></body></html>`;
}

async function transcriptExists(path: string): Promise<boolean> {
  const metadata = await fs.lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Cannot access transcript source');
  });
  if (!metadata) return false;
  if (metadata.size > 64 * 1024 * 1024) throw new Error('Transcript exceeds safety limit; explicitly import a smaller shard');
  if (metadata.isSymbolicLink()) throw new Error('Transcript source must not be a symbolic link');
  return metadata.isFile();
}

async function findStateRoot(workspace: string, executionId: string): Promise<string> {
  let current = workspace;
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      await fs.access(join(workspaceDataDirectory(current), 'executions', `${executionId}.jsonl`));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return workspace;
}

async function transcriptPath(workspace: string, provider: RetroOptions['provider'], sessionId: string): Promise<string | undefined> {
  if (provider === 'codex') return findCodexRollout(sessionId);
  if (provider === 'opencode') return `opencode://session/${encodeURIComponent(sessionId)}`;
  let realWorkspace = workspace;
  try { realWorkspace = realpathSync(workspace); } catch { /* workspace may be a fixture */ }
  const slug = claudeProjectSlug(realWorkspace);
  return join(homedir(), '.claude', 'projects', slug, `${sessionId}.jsonl`);
}

function assertRetroEvidence(findings: z.infer<typeof modelOutputSchema>['findings'], pack: EvidencePack): void {
  const evidenceIds = new Set(pack.entries.map(entry => entry.ref.id));
  if (findings.some(finding => finding.evidence.some(reference => !evidenceIds.has(reference)))) {
    throw new Error('Unknown evidence reference in retro findings');
  }
}

async function invokeRetro(pack: EvidencePack): Promise<z.infer<typeof modelOutputSchema>> {
  const result = await executeAnalysis({ provider: new ClaudeCodeProvider(), jobId: `retro:${pack.digest}`,
    prompt: buildRetroPrompt(pack) });
  const output = z.object({ type: z.literal('goal_complete'), report: modelOutputSchema }).strict().parse(result.output).report;
  assertRetroEvidence(output.findings, pack);
  return output;
}

async function readEvents(store: JsonlEventStore, runId: string): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) events.push(event);
  return events;
}

function sessionEvents(events: readonly Event[]): Array<{ sessionId: string; transcriptPath?: string; observedUsage?: unknown; observedTools?: AgentToolCallSummary[] }> {
  return events.flatMap(event => event.data.kind === 'agent.session_recorded' ? [{
    sessionId: event.data.sessionId,
    transcriptPath: event.data.transcriptPath,
    observedUsage: event.data.usage,
    observedTools: event.data.tools,
  }] : []);
}

async function runRetro(options: RetroOptions): Promise<RetroReport> {
  const store = new JsonlEventStore({ root: options.root });
  const events = await readEvents(store, options.runId);
  const integrity = await store.verify(options.runId);
  const workItemId = options.workItemId ?? events.find(event => event.context.workItemId)?.context.workItemId;
  if (!workItemId) throw new Error(`cannot infer work item for run '${options.runId}'`);
  const stateRoot = await findStateRoot(options.workspace, options.executionId);
  const journalPath = join(workspaceDataDirectory(stateRoot), 'executions', `${options.executionId}.jsonl`);
  const auditPath = join(store.root, `${Buffer.from(options.runId, 'utf8').toString('base64url')}.jsonl`);
  const evidenceSources: EvidenceSourceInput[] = [
    { id: 'audit-1', kind: 'audit', path: auditPath, allowedRoot: store.root, runId: options.runId },
    { id: 'journal-1', kind: 'journal', path: journalPath, allowedRoot: dirname(journalPath) },
  ];

  const sessions = integrity.valid ? sessionEvents(events) : [];
  const sessionProjections: Array<{ sessionId: string; source: 'transcript_found' | 'transcript_missing' | 'transcript_unindexed'; transcriptPath?: string; usage?: unknown; tools?: AgentToolCallSummary[]; transcript?: string }> = [];
  const missing: string[] = [];
  for (const session of sessions) {
    const recordedPath = options.transcript ?? session.transcriptPath;
    const archivedRoot = join(homedir(), '.afk', 'transcripts') + '/';
    const indexedPath = recordedPath && !recordedPath.startsWith(archivedRoot) ? recordedPath : undefined;
    const indexedTranscript = indexedPath ? await transcriptExists(indexedPath) : false;
    const path = indexedTranscript ? indexedPath : await transcriptPath(options.workspace, options.provider, session.sessionId);
    const transcript = indexedTranscript || (path ? await transcriptExists(path) : false);
    if (path && !path.startsWith('opencode://')) evidenceSources.push({
      id: `session-${evidenceSources.length}`, kind: 'session', path, allowedRoot: dirname(path), provider: options.provider,
    });
    if (!path || !transcript) {
      missing.push(`transcript:${session.sessionId}`);
      sessionProjections.push({ sessionId: session.sessionId, source: 'transcript_missing', ...(path ? { transcriptPath: path } : {}), tools: undefined, usage: undefined });
      continue;
    }
    const telemetryOptions = { provider: options.provider, transcriptPath: path, sandboxKind: 'local' as const };
    const [usage, tools] = await Promise.all([readAgentTelemetry(telemetryOptions), readAgentTools(telemetryOptions)]);
    if (!usage && !tools) missing.push(`telemetry:${session.sessionId}`);
    sessionProjections.push({ sessionId: session.sessionId, source: indexedTranscript ? 'transcript_found' : 'transcript_unindexed', transcriptPath: path, usage, tools });
  }

  const pack = await buildEvidencePack({ sources: evidenceSources });
  const evidence: EvidenceFile[] = pack.sources.flatMap(source => {
    const input = evidenceSources.find(entry => entry.id === source.id)!;
    return source.sourceDigest ? [{ kind: source.kind === 'session' ? 'transcript' : source.kind, path: input.path,
      uri: `evidence://${source.sourceDigest}`, sha256: source.sourceDigest, mediaType: 'application/x-ndjson' }] : [];
  });
  for (const session of sessionProjections) {
    const transcript = evidence.find(entry => entry.kind === 'transcript' && entry.path === session.transcriptPath);
    if (transcript) session.transcript = transcript.uri;
  }

  const sessionStore = defaultSessionStoreChain(stateRoot);
  const checkpoint = await sessionStore.loadFirst({ runId: options.executionId }).catch(() => null);
  const manifest = {
    version: 1,
    retroVersion: RETRO_VERSION,
    runId: options.runId,
    executionId: options.executionId,
    workItemId,
    eventStream: { valid: integrity.valid, eventCount: events.length, lastSequence: integrity.lastSequence, lastHash: integrity.lastHash, reason: integrity.reason },
    sessions: sessionProjections,
    sessionStore: checkpoint?.storeName ?? 'missing',
    files: evidence.map(({ path: _path, ...entry }) => entry),
    missing,
  };
  const inputHash = sha256(stableJson({ ...manifest, evidenceDigest: pack.digest }));
  const retroId = `retro-${inputHash.slice(0, 20)}`;
  const outputDir = join(workspaceDataDirectory(stateRoot), 'retro', retroId);
  const existingReportPath = join(outputDir, 'report.json');
  try {
    const existing = reportSchema.parse(JSON.parse(await fs.readFile(existingReportPath, 'utf8')));
    if (existing.source !== 'failure') {
      assertRetroEvidence(existing.findings, pack);
      await fs.writeFile(join(outputDir, reportHtmlFile), renderRetroHtml(existing), 'utf8');
      return existing;
    }
  } catch {
    // Generate a fresh report when the previous attempt failed.
  }
  await fs.mkdir(outputDir, { recursive: true });
  const inputPath = join(outputDir, 'input.json');
  await saveEvidencePack(join(outputDir, 'evidence'), pack);
  await fs.writeFile(inputPath, JSON.stringify(pack, null, 2));
  let model: z.infer<typeof modelOutputSchema> | undefined;
  let modelError: string | undefined;
  try {
    model = await invokeRetro(pack);
  } catch (error) {
    modelError = error instanceof Error ? error.message : String(error);
  }
  const toolList = sessionProjections.flatMap(session => session.tools ?? []);
  const journalSources = new Set(pack.sources.filter(source => source.kind === 'journal').map(source => source.id));
  const retryCount = pack.entries.filter(entry => journalSources.has(entry.position.sourceId) && /retry/i.test(entry.content)).length;
  const checkFailureCount = events.filter(event => event.data.kind === 'qa.failed' || (event.data.kind === 'step.completed' && event.data.outcome === 'failed')).length;
  const hasUnindexedTranscript = sessionProjections.some(session => session.source === 'transcript_unindexed');
  const source = model ? (integrity.valid && pack.completeness === 'complete' && missing.length === 0 && !hasUnindexedTranscript ? 'final' : 'provisional') : 'failure';
  const report = reportSchema.parse({
    version: 1,
    retroId,
    executionId: options.executionId,
    runId: options.runId,
    workItemId,
    source,
    summary: model?.summary ?? `Retro failed: ${modelError ?? 'unknown error'}`,
    metrics: {
      sessionCount: sessionProjections.length,
      toolCallCount: toolList.length,
      failedToolCallCount: toolList.filter(tool => tool.result === 'failed').length,
      retryCount,
      checkFailureCount,
      missingEvidenceCount: missing.length + (integrity.valid ? 0 : 1),
    },
    findings: model?.findings ?? [{
      id: 'retro-execution-failed', category: 'information_access', severity: 'high',
      title: 'Retro analysis did not complete', evidence: evidence.map(item => item.uri).length > 0 ? evidence.map(item => item.uri) : ['evidence://missing'],
      rootCause: modelError ?? 'unknown error', recommendation: 'Inspect the recorded evidence and rerun retro.', confidence: 1,
      disposition: 'record_only',
    }],
    evidence: evidence.map(item => item.uri),
    sessions: sessionProjections.map(session => ({ sessionId: session.sessionId, source: session.source, ...(session.transcriptPath ? { transcriptPath: session.transcriptPath } : {}) })),
    generatedAt: new Date().toISOString(),
  });
  await fs.writeFile(join(outputDir, 'manifest.json'), JSON.stringify({ ...manifest, inputHash }, null, 2));
  await fs.writeFile(join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(join(outputDir, reportHtmlFile), renderRetroHtml(report), 'utf8');
  return report;
}

function emit(value: unknown, json = false): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }

  if (!value || typeof value !== 'object') {
    process.stdout.write(`${String(value)}\n`);
    return;
  }

  const report = value as {
    summary?: unknown;
    retroId?: unknown;
    htmlPath?: unknown;
    metrics?: Record<string, unknown>;
    findings?: Array<{ severity?: unknown; title?: unknown; recommendation?: unknown }>;
  };
  const lines = [typeof report.summary === 'string' ? report.summary : 'Retro report'];
  if (typeof report.retroId === 'string') lines.push(`Report: ${report.retroId}`);
  if (report.metrics) {
    lines.push('', 'Metrics');
    for (const [name, metric] of Object.entries(report.metrics)) lines.push(`  ${name}: ${String(metric)}`);
  }
  if (report.findings?.length) {
    lines.push('', `Findings (${report.findings.length})`);
    for (const finding of report.findings) {
      lines.push(`  - [${String(finding.severity ?? 'unknown')}] ${String(finding.title ?? 'Untitled finding')}`);
      if (typeof finding.recommendation === 'string') lines.push(`    ${finding.recommendation}`);
    }
  }
  if (typeof report.htmlPath === 'string') lines.push('', `HTML report: ${report.htmlPath}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

export function registerRetroCommands(program: Command, _context: CommandRegistrationContext = {}): void {
  const retro = program.command('retro').description('Analyze an AFK run from bounded evidence');
  retro.command('run')
    .description('Read a completed run and generate a retro report')
    .requiredOption('--run-id <id>', 'AFK run ID')
    .requiredOption('--workspace <path>', 'Workspace containing .afk state')
    .option('--execution-id <id>', 'Execution journal ID; defaults to run ID')
    .option('--work-item-id <id>', 'Canonical work item ID')
    .option('--provider <provider>', 'claude-code, codex, or opencode', 'claude-code')
    .option('--transcript <path>', 'Explicit transcript path for fixture/replay runs')
    .option('--root <path>', 'AFK event-store root')
    .option('--json', 'Emit JSON')
    .action(async options => {
      const executionId = options.executionId ?? options.runId;
      const report = await runRetro({ ...options, executionId });
      const stateRoot = await findStateRoot(options.workspace, executionId);
      emit({ ...report, htmlPath: join(workspaceDataDirectory(stateRoot), 'retro', report.retroId, reportHtmlFile) }, options.json);
    });

  retro.command('show <report>')
    .description('Show a saved retro report')
    .option('--json', 'Emit JSON')
    .action(async (reportPath, options) => emit(JSON.parse(await fs.readFile(reportPath, 'utf8')), options.json));
}

export { reportSchema, renderRetroHtml, runRetro };
