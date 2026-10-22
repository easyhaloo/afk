import { executeWorkItem, type ExecuteWorkItemInput } from '@afk/runtime/execution';

async function main() {
  const input = JSON.parse(process.argv[2] ?? 'null') as ExecuteWorkItemInput | null;
  if (!input || typeof input.workItemId !== 'string' || typeof input.manifestPath !== 'string') throw new Error('invalid execution worker request');
  const result = await executeWorkItem(input);
  process.exitCode = result.status === 'done' || result.status === 'merge_ready' ? 0 : 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
