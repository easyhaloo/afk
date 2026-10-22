import { createHash } from 'node:crypto';
import { canonicalJson } from './project.js';
import type { GraphReceipt, GraphSnapshot } from './ir.js';

export function createReceipt(input: unknown, snapshot: GraphSnapshot, coreVersion = '0.1.0', generatedAt = new Date().toISOString()): GraphReceipt {
  return { inputHash: createHash('sha256').update(canonicalJson(input)).digest('hex'), snapshotHash: createHash('sha256').update(canonicalJson(snapshot)).digest('hex'), coreVersion, generatedAt };
}
