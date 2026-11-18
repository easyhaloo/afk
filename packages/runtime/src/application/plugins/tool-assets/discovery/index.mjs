import { listPluginInventory } from '@afk/runtime/plugin-sdk';
import manifest from './plugin.json' with { type: 'json' };

const text = value => typeof value === 'string' && value.trim().length > 0;

async function matchTool(row, provider, policy, { scope, target, applicability, prompt }) {
  if (typeof provider?.readToolDescription !== 'function' || typeof provider.verify !== 'function' ||
    provider.id !== row.id || provider.version !== row.manifest.version || !text(provider.source) ||
    typeof provider.sourceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(provider.sourceDigest)) return;
  const grant = await policy.evaluate({ action: 'tool.source.read', context: {
    project: scope, plugin: row.id, version: provider.version, source: provider.source, digest: provider.sourceDigest,
  } });
  if (grant?.allowed !== true) return;
  const source = await provider.readToolDescription(scope);
  if (!source || source.project !== scope || source.environment !== applicability.environment || !text(source.description) ||
    !Array.isArray(source.names) || !source.names.every(text)) return;
  const versions = source.productVersions;
  if (!versions || typeof versions !== 'object' || Array.isArray(versions)) return;
  const prototype = Object.getPrototypeOf(versions);
  if (prototype !== Object.prototype && prototype !== null) return;
  if (!Object.entries(versions).every(([product, version]) => text(product) && text(version) &&
      Object.hasOwn(target.productVersions ?? {}, product) && target.productVersions[product] === version)) return;
  const score = source.names.reduce((best, name) => prompt.includes(name) ? Math.max(best, name.length) : best, 0);
  if (score) return { score, origin: `${row.id}@${row.manifest.version}`, content: JSON.stringify({
    description: source.description, capability: 'verification.provider', provider: row.id, operation: 'verify',
  }) };
}

export default ({ homeDir }) => ({
  manifest,
  activate(context) {
    context.registerContextProvider(manifest.id, {
      id: manifest.id,
      capabilities: { 'read-only': true, search: true, summarize: false },
      async gather(query) {
        const { scope, target, applicability, prompt, limit } = query;
        if (scope !== target?.project || !applicability?.environment || !prompt.trim()) return [];
        const policy = context.getProvider('policy.provider', 'compliance-policy');
        if (!policy) return [];
        const matches = [];
        for (const row of await listPluginInventory({ homeDir })) {
          if (row.builtin || !row.enabled || !row.capabilities.includes('verification.provider')) continue;
          try {
            const match = await matchTool(row, context.getProvider('verification.provider', row.id), policy, query);
            if (match) matches.push(match);
          } catch { continue; }
        }
        return matches.sort((left, right) => right.score - left.score || left.origin.localeCompare(right.origin))
          .slice(0, limit).map(({ origin, content }) => ({ origin, content }));
      },
    });
  },
});
