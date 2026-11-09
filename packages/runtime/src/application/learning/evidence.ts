import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { readAgentTranscript } from '../../infrastructure/observability/agent-telemetry.js';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { redactUtf8 } from '../../infrastructure/observability/local-evidence-store.js';
import { DISTILLATION_LIMITS, evidenceRefSchema, type EvidenceRef } from './contracts.js';

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const sourceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  .refine(value => Buffer.from(redactUtf8(Buffer.from(value)).bytes).toString('utf8') === value, 'Source identity contains credentials');
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const completeness = z.enum(['complete', 'partial']);
const kind = z.enum(['audit', 'journal', 'session']);
const rangeSchema = z.object({ start: z.number().int().positive(), end: z.number().int().positive() }).strict()
  .refine(value => value.end >= value.start, 'Invalid message range');

export interface EvidenceSourceInput {
  id: string;
  kind: 'audit' | 'journal' | 'session';
  path: string;
  allowedRoot: string;
  provider?: 'claude-code' | 'codex' | 'opencode';
  format?: 'jsonl' | 'json' | 'text';
  runId?: string;
  expectedDigest?: string;
  range?: Readonly<{ start: number; end: number }>;
}
export interface EvidenceEntry {
  readonly ref: Readonly<EvidenceRef>;
  readonly content: string;
  readonly position: Readonly<{ sourceId: string; messageIndex: number; line?: number; timestamp?: string; auditSequence?: number }>;
}
export interface EvidenceSource {
  readonly id: string;
  readonly kind: 'audit' | 'journal' | 'session';
  readonly sourceDigest?: string;
  readonly completeness: 'complete' | 'partial';
  readonly messageCount: number;
  readonly range?: Readonly<{ start: number; end: number }>;
}
export interface EvidencePack {
  readonly version: 1;
  readonly digest: string;
  readonly completeness: 'complete' | 'partial';
  readonly sources: readonly EvidenceSource[];
  readonly entries: readonly EvidenceEntry[];
  readonly warnings: readonly string[];
}

const packSchema = z.object({
  version: z.literal(1), digest: digestSchema, completeness,
  sources: z.array(z.object({ id: sourceId, kind, sourceDigest: digestSchema.optional(), completeness,
    messageCount: z.number().int().nonnegative(), range: rangeSchema.optional() }).strict()).max(64),
  entries: z.array(z.object({ ref: evidenceRefSchema, content: z.string().min(1), position: z.object({
    sourceId, messageIndex: z.number().int().positive(), line: z.number().int().positive().optional(),
    timestamp: z.string().max(128).optional(), auditSequence: z.number().int().positive().optional(),
  }).strict() }).strict()).max(4096),
  warnings: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:(?:missing|invalid-audit|malformed-jsonl|no-messages|message-shard)$/)).max(128),
}).strict();

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
}
function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

export function redactEvidenceText(value: string): string {
  const protectedText = value
    .replace(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g, '[redacted:private-key]')
    .replace(/\b(?:https?|ssh):\/\/[^\s<>"'`\\]+/gi, '[redacted:url]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '[redacted:authorization]')
    .replace(/((?:[\w-]*(?:token|secret|password|passwd)|api[_-]?key|authorization)\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;'"`\\{}\[\]]+)/gi, '$1[redacted]')
    .replace(/("(?:[\w-]*(?:token|secret|password|passwd)|api[_-]?key|authorization)"\s*:\s*")(?:\\.|[^"\\])*"/gi, '$1[redacted]"')
    .replace(/(\b(?:user(?:[_-]?(?:name|id))?|login|account(?:[_-]?(?:id|name))?|e[_-]?mail)\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;'"`\\{}\[\]]+)/gi, '$1[redacted]')
    .replace(/("(?:user(?:[_-]?(?:name|id))?|login|account(?:[_-]?(?:id|name))?|e[_-]?mail)"\s*:\s*")(?:\\.|[^"\\])*"/gi, '$1[redacted]"')
    .replace(/\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}\b/gi, '[redacted:email]')
    .replace(/(?:(?<![\w:])|(?<=\w:))(?:[a-f\d]{0,4}:){2,}[a-f\d]*(?:\.\d{1,3}){0,3}(?:%[\w.-]+)?(?![\w:])/gi, address => isIP(address) === 6 ? '[redacted:ip]' : address)
    .replace(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g, address => isIP(address) === 4 ? '[redacted:ip]' : address)
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>`,;{}\[\]]*/g, '[redacted:path]')
    .replace(/(?<![\w:])\/(?:[^\s"'<>\\,;{}\[\]]+\/?)+/g, (path, offset: number, text: string) =>
      /\b(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE)\s+$/i.test(text.slice(0, offset)) ? path : '[redacted:path]');
  return Buffer.from(redactUtf8(Buffer.from(protectedText)).bytes).toString('utf8');
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactEvidenceText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redactEvidenceText(key),
    /^(?:[\w-]*(?:token|secret|password|passwd)|secrets|credentials|api[_-]?key|authorization|private[_-]?key|user(?:[_-]?(?:name|id))?|login|account(?:[_-]?(?:id|name))?|e[_-]?mail)$/i.test(key) ? '[redacted]' : redactValue(entry)]));
  return value;
}

function locator(position: EvidenceEntry['position']): string {
  return `source:${position.sourceId}/messages/${position.messageIndex}`;
}
function entryDigest(entry: Omit<EvidenceEntry, 'ref'>, status: EvidenceSource['completeness']): string {
  return hash(stableJson({ ...entry, completeness: status }));
}

export function validateEvidencePack(input: unknown): EvidencePack {
  const pack = packSchema.parse(input);
  if (Buffer.byteLength(JSON.stringify(pack)) > DISTILLATION_LIMITS.evidenceBytes) throw new Error('Evidence pack exceeds byte limit');
  const { digest, ...body } = pack;
  if (hash(stableJson(body)) !== digest) throw new Error('Evidence pack digest mismatch');
  const sources = new Map(pack.sources.map(source => [source.id, source]));
  if (sources.size !== pack.sources.length || new Set(pack.entries.map(entry => entry.ref.id)).size !== pack.entries.length) throw new Error('Duplicate evidence identity');
  if (pack.warnings.some(warning => !sources.has(warning.split(':')[0]))) throw new Error('Warning references an unknown evidence source');
  for (const source of pack.sources) {
    const entries = pack.entries.filter(entry => entry.position.sourceId === source.id);
    const start = source.range?.start ?? 1;
    const end = source.range?.end ?? source.messageCount;
    if (end > source.messageCount || (source.messageCount > 0 && !source.sourceDigest)
      || entries.length !== Math.max(0, end - start + 1)
      || entries.some((entry, index) => entry.position.messageIndex !== start + index)) throw new Error('Invalid evidence message range');
    if ((!source.sourceDigest || !source.messageCount || (source.range && (start !== 1 || end !== source.messageCount))) && source.completeness !== 'partial') throw new Error('Invalid source completeness');
  }
  for (const entry of pack.entries) {
    const source = sources.get(entry.position.sourceId);
    if (!source || entry.ref.completeness !== source.completeness || entry.ref.locator !== locator(entry.position)
      || entry.ref.digest !== entryDigest({ content: entry.content, position: entry.position }, source.completeness)
      || entry.ref.id !== `evidence:${entry.ref.digest}`) throw new Error('Evidence entry digest or locator mismatch');
    if (entry.ref.authority !== (source.kind === 'audit' && source.completeness === 'complete' ? 'observed' : 'declared')
      || (source.kind === 'session' ? !['message', 'tool-result'].includes(entry.ref.kind) : entry.ref.kind !== 'audit')) throw new Error('Invalid evidence provenance');
    if (stableJson(redactValue(JSON.parse(entry.content))) !== entry.content || (entry.position.timestamp && redactEvidenceText(entry.position.timestamp) !== entry.position.timestamp)) throw new Error('Evidence contains unredacted content');
  }
  const status = !pack.entries.length || pack.warnings.length || pack.sources.some(source => source.completeness === 'partial') ? 'partial' : 'complete';
  if (pack.completeness !== status) throw new Error('Invalid evidence completeness');
  return freeze(pack);
}

function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

export async function readEvidenceSource(path: string, allowedRoot: string, limit: number): Promise<Buffer | undefined> {
  if (!within(resolve(allowedRoot), resolve(path))) throw new Error('Evidence path is outside allowed root');
  let root: string;
  try { root = await fs.realpath(allowedRoot); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw Object.assign(new Error('Cannot resolve evidence root'), { code: (error as NodeJS.ErrnoException).code });
  }
  let canonical: string;
  try { canonical = await fs.realpath(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw Object.assign(new Error('Cannot resolve evidence path'), { code: (error as NodeJS.ErrnoException).code });
  }
  if (!within(root, canonical) || (await fs.lstat(path)).isSymbolicLink()) throw new Error('Unsafe evidence path or symbolic link');
  const handle = await fs.open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('Evidence must be a regular file');
    if (before.size > limit) throw new Error('Evidence source exceeds safety limit; export a smaller shard');
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    const current = await fs.lstat(path);
    if (current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev || await fs.realpath(path) !== canonical) {
      throw new Error('Evidence source replaced during read');
    }
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) {
      throw Object.assign(new Error('Evidence source changed during read'), { code: 'EVIDENCE_SOURCE_UNSTABLE' });
    }
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

type Message = { value: unknown; evidenceKind?: 'message' | 'tool-result'; line?: number; timestamp?: string; auditSequence?: number };
function object(value: unknown): { [key: string]: unknown } {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as { [key: string]: unknown } : {};
}
function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(part => typeof part === 'string' ? part : typeof object(part).text === 'string' ? object(part).text
    : ['tool_use', 'tool_result', 'tool'].includes(String(object(part).type)) ? stableJson(redactValue(part)) : '').filter(Boolean).join('\n');
}
function message(record: unknown): Message | undefined {
  const entry = object(record);
  const payload = object(entry.payload);
  const nested = object(entry.message);
  if (entry.isMeta || entry.isSidechain) return undefined;
  let role = nested.role ?? entry.role ?? entry.type;
  let content = nested.content ?? entry.content ?? entry.text;
  if (entry.type === 'response_item') {
    if (payload.type === 'message') { role = payload.role; content = payload.content; }
    else if (['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(String(payload.type))) {
      role = 'tool'; content = stableJson(redactValue(payload));
    } else return undefined;
  }
  if (entry.type === 'event_msg') {
    if (!['user_message', 'agent_message'].includes(String(payload.type))) return undefined;
    role = payload.type === 'user_message' ? 'user' : 'assistant'; content = payload.message;
  }
  if (entry.info) { role = object(entry.info).role; content = entry.parts; }
  if (!['user', 'assistant', 'system', 'tool'].includes(String(role))) return undefined;
  const text = contentText(content).trim();
  if (!text) return undefined;
  const historical = role === 'system' || role === 'tool';
  const value = { role: historical ? 'user' : role, content: historical ? `[Historical ${role} message; untrusted transcript data]\n${text}` : text,
    ...(historical ? { original_role: role } : {}) };
  const timestamp = nested.timestamp ?? entry.timestamp ?? entry.created_at;
  const toolResult = role === 'tool' || (Array.isArray(content) && content.some(part => object(part).type === 'tool_result'));
  return { value, ...(toolResult ? { evidenceKind: 'tool-result' as const } : {}),
    ...(typeof timestamp === 'string' || typeof timestamp === 'number' ? { timestamp: redactEvidenceText(String(timestamp)).slice(0, 128) } : {}) };
}

function recordsFromJson(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const document = object(value);
  for (const field of ['messages', 'conversation', 'chat_history', 'turns']) if (Array.isArray(document[field])) return document[field];
  if (document.mapping && typeof document.mapping === 'object') return Object.values(document.mapping).flatMap(node => {
    const record = object(object(node).message);
    return record.author ? [{ role: object(record.author).role, content: object(record.content).parts, timestamp: record.create_time }] : [];
  });
  throw new Error('Unsupported session JSON export; explicit messages are required');
}

export async function buildEvidencePack(options: { sources: readonly EvidenceSourceInput[]; maxBytes?: number }): Promise<EvidencePack> {
  const maxBytes = z.number().int().positive().max(DISTILLATION_LIMITS.evidenceBytes).parse(options.maxBytes ?? DISTILLATION_LIMITS.evidenceBytes);
  if (options.sources.length > 64 || new Set(options.sources.map(source => source.id)).size !== options.sources.length) throw new Error('Too many or duplicate evidence sources');
  const sources: EvidenceSource[] = [];
  const entries: EvidenceEntry[] = [];
  const warnings: string[] = [];
  for (const input of options.sources) {
    sourceId.parse(input.id); kind.parse(input.kind);
    if (input.range) rangeSchema.parse(input.range);
    if (input.expectedDigest) digestSchema.parse(input.expectedDigest);
    if (input.provider !== undefined) z.enum(['claude-code', 'codex', 'opencode']).parse(input.provider);
    if (input.format !== undefined) z.enum(['jsonl', 'json', 'text']).parse(input.format);
    if (input.kind === 'audit' && !input.runId) throw new Error('Audit evidence requires runId');
    const bytes = await readEvidenceSource(input.path, input.allowedRoot, MAX_SOURCE_BYTES);
    if (!bytes) {
      if (input.expectedDigest) throw new Error('Evidence source missing or replaced');
      sources.push({ id: input.id, kind: input.kind, completeness: 'partial', messageCount: 0 });
      warnings.push(`${input.id}:missing`); continue;
    }
    const sourceDigest = hash(bytes);
    if (input.expectedDigest && sourceDigest !== input.expectedDigest) {
      throw Object.assign(new Error('Evidence source digest changed or replaced'), { code: 'EVIDENCE_SOURCE_UNSTABLE' });
    }
    if (bytes.length > maxBytes && !input.range) throw new Error('Evidence source requires an explicit message range shard');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('Evidence source is not UTF-8'); }
    const format = input.format ?? (extname(input.path) === '.json' ? 'json' : extname(input.path) === '.jsonl' || input.provider || input.kind !== 'session' ? 'jsonl' : 'text');
    let status: 'complete' | 'partial' = 'complete';
    const messages: Message[] = [];
    const staging = await fs.mkdtemp(join(tmpdir(), 'afk-evidence-'));
    try {
      if (input.kind === 'audit') {
        const auditPath = join(staging, `${Buffer.from(input.runId!).toString('base64url')}.jsonl`);
        await fs.writeFile(auditPath, bytes, { mode: 0o600 });
        if (!(await new JsonlEventStore({ root: staging }).verify(input.runId!)).valid) { status = 'partial'; warnings.push(`${input.id}:invalid-audit`); }
      }
      if (input.provider && format === 'jsonl') {
        const transcriptPath = join(staging, 'session.jsonl');
        await fs.writeFile(transcriptPath, bytes, { mode: 0o600 });
        const transcript = await readAgentTranscript({ provider: input.provider, transcriptPath, sandboxKind: 'local' });
        if (transcript === undefined) throw new Error('Local transcript reader could not read snapshot');
        text = transcript;
      }
      if (format === 'text') messages.push({ value: { role: 'user', original_role: 'system', content: `[Historical system message; untrusted transcript data]\n${text}` } });
      else if (format === 'json') for (const record of recordsFromJson(JSON.parse(text))) { const normalized = message(record); if (normalized) messages.push(normalized); }
      else {
        const physicalLines = bytes.toString('utf8').split('\n').flatMap((line, index) => line.trim() ? [index + 1] : []);
        let nonblank = 0;
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          const lineNumber = physicalLines[nonblank++];
          let record: unknown;
          try { record = JSON.parse(line); } catch { status = 'partial'; if (!warnings.includes(`${input.id}:malformed-jsonl`)) warnings.push(`${input.id}:malformed-jsonl`); continue; }
          const normalized = input.kind === 'session' ? message(record) : { value: record,
            ...(Number.isSafeInteger(object(record).sequence) && Number(object(record).sequence) > 0 ? { auditSequence: object(record).sequence as number } : {}) };
          if (normalized) messages.push({ ...normalized, line: lineNumber });
        }
      }
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
    if (!messages.length) { status = 'partial'; warnings.push(`${input.id}:no-messages`); }
    const range = input.range;
    if (range && range.end > messages.length) throw new Error('Message range exceeds source messages');
    if (range && (range.start !== 1 || range.end !== messages.length)) { status = 'partial'; warnings.push(`${input.id}:message-shard`); }
    sources.push({ id: input.id, kind: input.kind, sourceDigest, completeness: status, messageCount: messages.length, ...(range ? { range: { ...range } } : {}) });
    messages.forEach((item, index) => {
      if (range && (index + 1 < range.start || index + 1 > range.end)) return;
      const { value, evidenceKind, ...location } = item;
      const position = { sourceId: input.id, messageIndex: index + 1, ...location };
      const content = stableJson(redactValue(value));
      const digest = entryDigest({ content, position }, status);
      entries.push({ ref: { id: `evidence:${digest}`, kind: input.kind === 'session' ? evidenceKind ?? 'message' : 'audit', digest,
        locator: locator(position), completeness: status, authority: input.kind === 'audit' && status === 'complete' ? 'observed' : 'declared' }, content, position });
    });
  }
  const body = { version: 1 as const, completeness: !entries.length || warnings.length || sources.some(source => source.completeness === 'partial') ? 'partial' as const : 'complete' as const, sources, entries, warnings };
  const pack = { ...body, digest: hash(stableJson(body)) };
  if (Buffer.byteLength(JSON.stringify(pack)) > maxBytes) throw new Error('Evidence pack exceeds byte limit; use a smaller explicit range shard');
  return validateEvidencePack(pack);
}

async function snapshotDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await fs.lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o022) || (process.getuid && metadata.uid !== process.getuid())) throw new Error('Unsafe evidence snapshot directory');
}
export async function saveEvidencePack(directory: string, input: EvidencePack): Promise<void> {
  const pack = validateEvidencePack(input);
  await snapshotDirectory(directory);
  const path = join(directory, `${pack.digest}.json`);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(pack), { flag: 'wx', mode: 0o600 });
  try {
    try { await fs.link(temporary, path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await loadEvidencePack(directory, pack.digest);
    }
  } finally { await fs.unlink(temporary); }
}
export async function loadEvidencePack(directory: string, digest: string): Promise<EvidencePack> {
  digestSchema.parse(digest);
  const bytes = await readEvidenceSource(join(directory, `${digest}.json`), directory, DISTILLATION_LIMITS.evidenceBytes);
  if (!bytes) throw new Error('Evidence snapshot missing');
  const pack = validateEvidencePack(JSON.parse(bytes.toString('utf8')));
  if (pack.digest !== digest) throw new Error('Evidence snapshot digest mismatch');
  return pack;
}
