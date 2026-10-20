import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { writeFileAtomic } from '@afk/infrastructure';
import type { WorkflowGraphResult } from './workflow-graph.js';
import type { WorkflowGraphFormat } from './workflow-graph.js';

export interface GraphCacheResult { readonly directory: string; readonly indexPath: string; readonly graphPath: string; readonly receiptPath: string; readonly archifyPath?: string; }

function assertSafeOutput(projectRoot: string, output: string): string {
  const resolved = resolve(projectRoot, output);
  const rel = relative(projectRoot, resolved);
  if (isAbsolute(output) && !resolved.startsWith(resolve(projectRoot, '.afk', 'cache', 'archify'))) throw new Error('--output must be workspace-relative or inside .afk/cache/archify');
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('--output must stay inside the workspace');
  return resolved;
}

export async function writeGraphCache(projectRoot: string, result: WorkflowGraphResult, format: WorkflowGraphFormat, output?: string): Promise<GraphCacheResult> {
  const base = resolve(projectRoot, '.afk', 'cache', 'archify', 'workflow', result.definition.templateId, result.receipt.inputHash);
  const directory = output ? assertSafeOutput(projectRoot, output) : base;
  await fs.mkdir(directory, { recursive: true });
  const graphPath = join(directory, 'graph.json');
  const receiptPath = join(directory, 'receipt.json');
  const indexPath = join(directory, 'index.json');
  const archifyPath = format === 'archify-json' ? join(directory, 'archify.workflow.json') : undefined;
  await writeFileAtomic(graphPath, `${JSON.stringify(result.snapshot, null, 2)}\n`, fs);
  await writeFileAtomic(receiptPath, `${JSON.stringify(result.receipt, null, 2)}\n`, fs);
  if (archifyPath && result.archify) await writeFileAtomic(archifyPath, `${JSON.stringify(result.archify, null, 2)}\n`, fs);
  await writeFileAtomic(indexPath, `${JSON.stringify({ templateId: result.definition.templateId, inputHash: result.receipt.inputHash, format, graph: graphPath, receipt: receiptPath, ...(archifyPath ? { archify: archifyPath } : {}) }, null, 2)}\n`, fs);
  return { directory, indexPath, graphPath, receiptPath, ...(archifyPath ? { archifyPath } : {}) };
}
