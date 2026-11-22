import { closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TokenUsage } from '../../../domain/agents/types.js';

export function createCopilotUsageReport() {
  const directory = mkdtempSync(join(tmpdir(), 'afk-copilot-'));
  const path = join(directory, 'usage.json');
  return { path, finish(): TokenUsage | undefined {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > 256 * 1024) return;
      const bytes = Buffer.alloc(stat.size);
      if (readSync(descriptor, bytes) !== bytes.length) return;
      const metrics = JSON.parse(bytes.toString()).modelMetrics;
      if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return;
      let inputTokens = 0;
      let outputTokens = 0;
      const models = Object.values(metrics) as { usage?: TokenUsage }[];
      if (!models.length) return;
      for (const model of models) {
        const usage = model?.usage;
        if (!usage || ![usage.inputTokens, usage.outputTokens].every(count => Number.isSafeInteger(count) && count >= 0)) return;
        inputTokens += usage.inputTokens;
        outputTokens += usage.outputTokens;
      }
      const totalTokens = inputTokens + outputTokens;
      if (Number.isSafeInteger(totalTokens)) return { inputTokens, outputTokens, totalTokens };
    } catch { return; } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(directory, { recursive: true, force: true });
    }
  } };
}
