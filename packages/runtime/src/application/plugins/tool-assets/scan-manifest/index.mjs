import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import manifest from './plugin.json' with { type: 'json' };

export default ({ installedEntryUrl }) => ({
  manifest,
  activate(context) {
    const source = new URL('./source.json', import.meta.url);
    const sourceId = new URL('./source.json', installedEntryUrl ?? import.meta.url).href;
    async function readToolDescription(project) {
      const policy = context.getProvider('policy.provider', 'compliance-policy');
      const decision = await policy?.evaluate({ action: 'tool.source.read', context: {
        project, plugin: manifest.id, version: manifest.version, source: sourceId, digest: manifest.sourceDigest,
      } });
      if (!decision?.allowed) return undefined;
      const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const bytes = await handle.readFile();
        if (createHash('sha256').update(bytes).digest('hex') !== manifest.sourceDigest) throw new Error('Tool source changed');
        return JSON.parse(bytes);
      } finally { await handle.close(); }
    }
    context.registerVerificationProvider(manifest.id, {
      id: manifest.id, version: manifest.version, source: sourceId, sourceDigest: manifest.sourceDigest,
      capabilities: { 'static-analysis': true, 'test-execution': false, 'custom-script': false }, readToolDescription,
      async verify({ target, input }) {
        const started = performance.now();
        if (typeof target !== 'string' || !target.trim() || (await readToolDescription(target))?.project !== target) throw new Error('Tool source read denied');
        const codes = input?.split('\n') ?? [];
        if (!codes.length) throw new Error('Expected a scan manifest');
        const invalidLines = [];
        for (const [index, code] of codes.entries()) {
          if (!/^\d{13}$/.test(code) || [...code].reduce((sum, digit, position) => sum + Number(digit) * (position % 2 ? 3 : 1), 0) % 10 !== 0) {
            invalidLines.push(index + 1);
          }
        }
        return { passed: !invalidLines.length, durationMs: performance.now() - started, output: JSON.stringify({ checked: codes.length, invalidLines }) };
      },
    });
  },
});
