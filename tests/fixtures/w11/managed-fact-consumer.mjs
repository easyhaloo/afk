import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, runtimeRoot, fixture, ...args] = process.argv.slice(2);
const runtime = module => import(pathToFileURL(join(runtimeRoot, `${module}.js`)).href);

async function publishedReceipt(cli, { asset, query }) {
  const file = join(fixture, '.afk/learning/candidates.sqlite');
  if (!existsSync(file)) return null;
  const list = resource => JSON.parse(execFileSync(process.execPath,
    [cli, 'experience', resource, '--scope', asset.scope, '--json'], { encoding: 'utf8' }));
  const jobs = list('jobs');
  const candidates = list('candidates');
  const { CandidateStore } = await runtime('application/learning/candidate-store');
  const store = new CandidateStore({ file });
  try {
    for (const candidate of candidates) {
      const { proposal } = candidate;
      if (candidate.state !== 'published' || proposal.kind !== 'fact' || proposal.payload.subject !== asset.key
        || proposal.payload.rule !== asset.source || proposal.applicability.project !== asset.scope
        || !proposal.applicability.versions.includes(query.target.productVersions.parcel)
        || !proposal.applicability.environments.includes(query.applicability.environment)) continue;
      const job = jobs.find(entry => entry.jobId === candidate.requestKey && entry.status === 'processed'
        && entry.scope === asset.scope && entry.workItemId === `${asset.scope}#42` && entry.sourceRunId === 'local-parcel-source');
      const producer = job?.attempts.find(attempt => attempt.requestKey === candidate.requestKey
        && attempt.status === 'succeeded' && attempt.analysisRunId && attempt.sessionId && attempt.usage?.totalTokens > 0);
      const validation = store.getValidation(candidate.id);
      if (!producer || !validation?.passed || validation.candidateDigest !== candidate.digest
        || validation.evidenceDigest !== candidate.evidenceDigest || validation.validatedVersion !== asset.edition
        || !validation.validatorVersion.startsWith('learning-validation-v1:')) continue;
      const publication = store.listPublications(candidate.id).find(pub => pub.phase === 'committed'
        && pub.targetRef === `wiki:${asset.key}` && pub.candidateVersion === validation.validatedVersion
        && pub.validatorVersion === validation.validatorVersion && pub.candidateDigest === candidate.digest
        && pub.evidenceDigest === candidate.evidenceDigest && pub.observedDigest === pub.targetDigest
        && !existsSync(join(dirname(file), 'publications', pub.key, 'withdrawal.json')));
      if (publication) return { publication, producerSession: producer.sessionId, producerRun: producer.analysisRunId };
    }
    return null;
  } finally {
    store.close();
  }
}

async function consume(question, scope, runDirectory, itemId, scenarioFile, agentProvider = 'opencode') {
  const workspace = process.cwd();
  const scenario = scenarioFile ? JSON.parse(await readFile(scenarioFile, 'utf8')) : undefined;
  const workflow = scenario ? 'tool-consumer' : 'fact-consumer';
  const workItemId = `${scope}#${itemId}`;
  const runId = `${workflow}-${randomUUID()}`;
  const branchName = `feat/${workflow}`;
  const item = { id: itemId, issueNumber: Number(itemId), workItemId, providerRef: workItemId, title: question,
    description: question, kind: 'task', state: 'ready', executionMode: 'afk', branchName, dependsOn: [], tags: [] };
  const git = (...command) => execFileSync('git', command, { cwd: workspace, stdio: 'pipe' });
  git('init', '-b', 'main');
  git('-c', 'user.name=W11', '-c', 'user.email=w11@example.invalid', 'commit', '--allow-empty', '-m', 'Consumer baseline');
  const template = join(workspace, '.afk/workflows/answer.yml');
  await mkdir(dirname(template), { recursive: true });
  await writeFile(template, `name: ${workflow}
version: 1
steps:
  - id: implement
    kind: agent
    role: implementer
    prompt: |-
      /goal ${question}
      ${scenario?.instructions ?? `只读一次 ${join(workspace, '.afk/experience-context.md')}。读取结束或文件不存在时，直接将结果写入 ${join(workspace, 'answer.json')} 并结束任务。资料范围限于该文件。
      答复使用三个 JSON 字段，无对应值的字段填 null。
      answer 逐字引用直接回答问题的一条完整规则。source 原样复制 Source 行冒号后直到行尾的所有内容。productVersion 填该规则适用的产品版本。`}
  - id: queue
    kind: system
    action: queue-qa
    dependsOn: [implement]
`);
  const { createDefaultPluginRuntime } = await runtime('plugin-sdk/index');
  const { WorkflowRunner } = await runtime('application/workflow-engine');
  const plugins = await createDefaultPluginRuntime({ homeDir: fixture, workspaceRoot: workspace });
  const knowledge = plugins.getContextProvider(scenario ? 'context.installed-tools' : 'context.knowledge');
  const gather = knowledge.gather.bind(knowledge);
  const retrievals = [];
  knowledge.gather = async (query, ...options) => {
    const fragments = await gather(query, ...options);
    retrievals.push({ query, origins: fragments.map(fragment => fragment.origin) });
    return fragments;
  };
  const events = [];
  let result;
  try {
    const runner = new WorkflowRunner({
      backlog: { get: async () => item, claim: async () => ({ item, release: async () => {}, heartbeat: async () => {} }),
        getActiveRework: async () => null, transition: async (_id, state) => { item.state = state; },
        setExecutionMode: async (_id, mode) => { item.executionMode = mode; }, addComment: async () => {} },
      branches: { createBranch: async () => { git('checkout', '-b', branchName); return { branchName, worktreePath: workspace }; },
        cleanup: async () => {} },
      changes: { findForBacklog: async () => null },
    }, { plugins, observer: { record: async (_context, event) => { events.push(event); } } });
    result = await runner.run({ backlogId: item.id, workItemId, session: runId, observationRunId: runId,
      observationWorkItemId: workItemId, targetBranch: branchName, baseBranch: 'main', baseBranchExplicit: true,
      repoRoot: workspace, workspaceRoot: workspace, template, agentProvider, sandboxProvider: 'local',
      executionMode: 'batch', completionTimeoutMs: 120_000, hardTimeoutMs: 150_000, maxHandoffs: 1, maxRetries: 0 });
  } catch (error) {
    result = { success: false, error: error.message };
  } finally {
    await plugins.dispose();
    await writeFile(join(runDirectory, 'result.json'), JSON.stringify({ runId, workItemId, result, events, retrievals }, null, 2));
  }
}

if (mode === 'gate') console.log(JSON.stringify(await publishedReceipt(args[0], JSON.parse(args[1]))));
else if (mode === 'consume') await consume(...args);
else throw new Error(`Unknown fixture mode ${mode}`);
