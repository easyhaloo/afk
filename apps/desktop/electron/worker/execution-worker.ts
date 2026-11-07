import { executeWorkItem, type ExecuteWorkItemInput } from '@afk/runtime/execution';
import { createDefaultPluginRuntime } from '@afk/runtime/plugin-sdk';

async function main() {
  const input = JSON.parse(process.argv[2] ?? 'null') as ExecuteWorkItemInput | null;
  if (!input || typeof input.workItemId !== 'string' || typeof input.manifestPath !== 'string') throw new Error('invalid execution worker request');
  const plugins = await createDefaultPluginRuntime({ warn: message => console.warn(message) });
  try {
    const result = await executeWorkItem(input, { plugins, agentProviderRegistry: plugins.getAgentProviderRegistry() });
    process.exitCode = result.status === 'done' || result.status === 'merge_ready' ? 0 : 1;
  } finally {
    await plugins.dispose();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
