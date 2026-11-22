import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const runtime = process.env.AFK_E2E_RUNTIME_ROOT;
const fromRuntime = name => import(pathToFileURL(join(runtime, `${name}.js`)));
const { createDefaultPluginRuntime } = await fromRuntime('plugin-sdk/index');
const { executeWorkItem } = await fromRuntime('application/workflows/execute-work-item');
const { JsonlEventStore } = await fromRuntime('infrastructure/observability/jsonl-event-store');
const workspaceRoot = process.env.WORKSPACE_E2E;
const workItemId = 'github:acme/api#42';
const executionId = process.argv[2];
const plugins = await createDefaultPluginRuntime({ homeDir: process.env.HOME, workspaceRoot });
const item = {
  id: workItemId, workItemId, issueNumber: 42,
  project: { platform: 'github', projectKey: 'acme/api', name: 'api' },
  managed: true, executionEligible: true, title: 'Observe', dependsOn: [],
  state: 'ready', executionMode: 'afk', tags: [], branchName: 'feature/42', providerRef: workItemId,
};
try {
  const result = await executeWorkItem({ workItemId, executionId, manifestPath: workspaceRoot + '/manifest.json' }, {
    plugins,
    lookupWorkItem: async () => item,
    readManifest: async () => ({ workItemId, providerBacklogId: '42', tracker: { platform: 'github', projectKey: 'acme/api' }, workspaceRoot, manifestPath: workspaceRoot + '/manifest.json' }),
    createContext: async () => ({
      providers: { backlog: { get: async () => item, isRunnable: async () => true, claim: async () => null, setExecutionMode: async () => undefined }, branches: {}, changes: { findForBacklog: async () => null } },
      request: { backlogId: '42', workspaceRoot, repoRoot: workspaceRoot, agentRuntime: { kind: 'default' }, targetBranch: 'main' },
    }),
  });
  const integrity = await new JsonlEventStore({ root: process.env.AFK_EVENT_STORE_DIR }).verify(executionId);
  console.log('OBSERVABILITY_RESULT=' + JSON.stringify({ result, integrity }));
} finally { await plugins.dispose(); }
