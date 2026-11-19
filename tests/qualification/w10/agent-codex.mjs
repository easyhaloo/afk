import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [release, root, output, scenario, codexVersion] = process.argv.slice(2);
const load = name => import(join(release, 'node_modules/@afk/runtime/dist', name + '.js'));
const { WorkflowRunner } = await load('application/workflow-engine');
const { createDefaultPluginRuntime } = await load('plugin-sdk/index');
const { resolveCodexRuntime, prepareAgentRuntime, DEFAULT_CODEX_CONFIG } = await load('domain/agents/codex-runtime');
const workspace = process.cwd();
const git = (...args) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore' });
git('init', '-b', 'main');
git('-c', 'user.name=Fixture', '-c', 'user.email=qa@example.invalid', 'commit', '--allow-empty', '-m', 'synthetic');
const branchName = 'feat/qual', workItemId = 'github:fixture/parcel#1', runId = randomUUID();
const value = Math.floor(Math.random() * 9000) + 1000;
writeFileSync('input.json', JSON.stringify({ quantities: [value, 13, 27] }));
const goal = scenario === 'cancel' ? 'Run exactly one shell command: touch started && sleep 12 && touch late. Wait for it to finish.' : 'Read input.json. Write only the sum of its quantities as a decimal integer to total.txt.';
const template = join(root, 'flow.yml');
writeFileSync(template, `name: qualification\nversion: 1\nsteps:\n  - id: implement\n    kind: agent\n    role: implementer\n    prompt: |-\n      /goal ${goal} Finish with <goal_complete>{"type":"goal_complete","kind":"task","summary":"done"}</goal_complete>.\n  - id: queue\n    kind: system\n    action: queue-qa\n    dependsOn: [implement]\n`);
const item = {id:'1', issueNumber:1, workItemId, providerRef:workItemId, title:goal, description:goal, kind:'task', state:'ready', executionMode:'afk', branchName, dependsOn:[], tags:[]};
let queued = false;
const providers = {
  backlog: { get:async()=>item, claim:async()=>({item,release:async()=>{},heartbeat:async()=>{}}), getActiveRework:async()=>null,
    transition:async (_id,state)=>{ item.state = state; if (state === 'verification') queued = true; }, setExecutionMode:async()=>{},addComment:async()=>{} },
  branches:{createBranch:async()=>{git('checkout','-b',branchName); return {branchName,worktreePath:workspace};},cleanup:async()=>{}},
  changes:{findForBacklog:async()=>null},
};
const transport = ['qa','app-server'].includes(scenario) ? 'app-server' : 'exec';
const receipt = { afk:JSON.parse(readFileSync(join(release,'release.json'))).version, codexVersion, scenario, transport, runId, workItemId };
const controller = new AbortController();
const poll = setInterval(()=>{if(scenario==='cancel' && existsSync('started') && !controller.signal.aborted) controller.abort(new Error('synthetic operator cancellation'));},50);
let plugins;
try {
  receipt.phase = 'readiness';
  const runtime = await prepareAgentRuntime(resolveCodexRuntime({cli:{transport},config:DEFAULT_CODEX_CONFIG}));
  receipt.phase = 'workflow';
  plugins = await createDefaultPluginRuntime({homeDir:process.env.HOME,workspaceRoot:workspace});
  const events = [];
  const runner = new WorkflowRunner(providers,{plugins,agentRuntime:runtime,observer:{record:async(_context,event)=>{events.push(event);}}});
  if(scenario==='failure') {
    assert.ok(process.env.QUAL_MODEL_AUTH);
    delete process.env.QUAL_MODEL_AUTH;
    receipt.authRemovedAfterReadiness = !process.env.QUAL_MODEL_AUTH;
  }
  const result = await runner.run({backlogId:'1',workItemId,session:runId,observationWorkItemId:workItemId,observationRunId:runId,
    targetBranch:branchName,baseBranch:'main',baseBranchExplicit:true,repoRoot:workspace,workspaceRoot:workspace,template,
    agentProvider:'codex',sandboxProvider:'local',executionMode:'batch',completionTimeoutMs:60000,hardTimeoutMs:90000,maxRetries:0,maxHandoffs:1,signal:controller.signal}).catch(error=>{
      const message=String(error.message);
      receipt.rejection={name:error.name, frames:String(error.stack).split('\n').filter(line=>/^\s+at /.test(line)).slice(0,4).map(line=>line.match(/\/([\w.-]+\.js):(\d+):\d+\)?$/)?.slice(1)??[]), markers:['synthetic operator cancellation','QUAL_MODEL_AUTH','environment variable','cancel','abort','blocked','failed','is not a function','interrupted','lease','Missing','credential'].filter(term=>message.toLowerCase().includes(term.toLowerCase()))};
      if(scenario!=='failure' && scenario!=='cancel') throw error;
      return {success:false};
    });
  const telemetry = events.find(event=>event.kind==='agent.session_recorded');
  receipt.workflowSuccess = result.success;
  receipt.sessionId = telemetry?.sessionId;
  receipt.totalTokens = telemetry?.usage?.totalTokens;
  receipt.queueStep = events.some(event=>event.kind==='step.completed' && (event.stepId==='queue'||event.stepName==='queue')) || queued;
  receipt.finalState=item.state;
  receipt.outputExists=existsSync('total.txt');
  receipt.eventKinds=[...new Set(events.map(event=>event.kind))];
  receipt.classifications=events.filter(event=>event.kind==='failure.classified').map(event=>({category:event.category,code:event.code}));
  receipt.phase='assertions';
  const codes = receipt.classifications.map(failure => failure.code);
  const terminal = events.find(event => event.kind === 'run.finished');
  receipt.terminalOutcome = terminal?.outcome;
  if(scenario==='failure'){
    assert.ok(codes.includes('agent_process_failed'));
    assert.ok(terminal);assert.equal(item.state,'blocked');
    assert.match(receipt.sessionId,/^[0-9a-f-]{36}$/);
    assert.equal(result.success,false);assert.equal(receipt.outputExists,false);assert.equal(receipt.queueStep,false);
  } else if(scenario==='cancel'){
    assert.ok(receipt.rejection?.markers.includes('synthetic operator cancellation'));
    assert.ok(terminal);assert.equal(item.state,'blocked');
    receipt.cancelAfterStart=controller.signal.aborted && existsSync('started');assert.equal(receipt.cancelAfterStart,true);assert.equal(result.success,false);assert.equal(receipt.queueStep,false);
    await delay(13000);receipt.delayedWrite=existsSync('late');assert.equal(receipt.delayedWrite,false);
  } else {
    assert.equal(result.success,true);receipt.expected=value+40;receipt.actual=Number(readFileSync('total.txt','utf8').trim());assert.equal(receipt.actual,receipt.expected);
    assert.match(receipt.sessionId,/^[0-9a-f-]{36}$/);
    const sessions=join(process.env.CODEX_HOME,'sessions');
    const transcript=existsSync(sessions)&&readdirSync(sessions,{recursive:true}).find(name=>name.endsWith(receipt.sessionId+'.jsonl'));
    receipt.nativeThreadMatch=Boolean(transcript);
    assert.equal(receipt.nativeThreadMatch,true);
    const native=readFileSync(join(sessions,transcript),'utf8').trim().split('\n').map(line=>JSON.parse(line));
    receipt.nativeTokens=native.findLast(row=>Number.isFinite(row.payload?.info?.total_token_usage?.total_tokens))?.payload.info.total_token_usage.total_tokens;
    assert.ok(receipt.nativeTokens>0);assert.ok(receipt.totalTokens>0);assert.equal(receipt.queueStep,true);assert.equal(item.state,'verification');
    receipt.usageMatches = receipt.nativeTokens === receipt.totalTokens;
    assert.equal(receipt.usageMatches,true,'product usage differs from native cumulative usage');
    if (scenario === 'qa') {
      receipt.phase = 'independent-qa';
      await qualifyQA(runtime);
    }
  }
  receipt.passed=true;
} catch(error){
  receipt.passed=false;receipt.errorClass=error.name;
  const message=String(error.message);
  receipt.diagnostic=['AUTH_INVALID','CLI_NOT_FOUND','PROVIDER_INVALID','ENDPOINT_UNREACHABLE','auth','doctor','model','timeout','profile'].filter(term=>message.toLowerCase().includes(term.toLowerCase()));
  process.exitCode=1;
} finally {
  clearInterval(poll);await plugins?.dispose();writeFileSync(output,JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
}

async function qualifyQA(runtime) {
  const { QARunner } = await load('application/runners/qa-runner');
  const { JsonlEventStore } = await load('infrastructure/observability/jsonl-event-store');
  const { getWorkflowConfig } = await load('infrastructure/config/manager');
  const worktreePath = join(root, 'qa-work');
  const verificationBranch = 'qa-1';
  const revision = () => execFileSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding:'utf8' }).trim();
  git('add', 'input.json', 'total.txt');
  git('-c','user.name=Fixture','-c','user.email=qa@example.invalid','commit','--allow-empty','-m','snapshot synthetic task');
  providers.branches.createVerificationWorktree = async () => {
    git('worktree','add','-b',verificationBranch,worktreePath,'main');
    return {worktreePath, branchName:verificationBranch};
  };
  providers.branches.mergeFeatureIntoBaseline = async () => {
    git('-C',worktreePath,'merge','--ff-only',branchName);
    return {merged:true, conflicts:[]};
  };
  providers.branches.verificationRevision = async () => {
    git('-C', worktreePath, 'diff', '--exit-code', 'HEAD', '--', 'input.json','total.txt');
    return revision();
  };
  providers.branches.push = async (_branch, _path, commit) => assert.equal(commit,revision());
  providers.changes.create = async ({sourceBranch,targetBranch}) => ({id:'local-1', url:'local:fixture', sourceBranch,targetBranch, mergeState:'mergeable'});
  const templates = join(process.env.HOME,'.afk','workflows');
  mkdirSync(templates,{recursive:true});
  writeFileSync(join(templates,'pre-merge-qa-verification.yml'), `name: fixture-qa\nversion: 1\nsteps:\n  - id: verify\n    kind: agent\n    role: qa\n    prompt: |-\n      Independently read input.json and total.txt using the shell. Compute sum(quantities). PASS only when total.txt is exactly the same decimal integer. Leave files unchanged. End with <goal_complete>{"type":"goal_complete","kind":"qa","result":"PASS","summary":"verified"}</goal_complete> for a match or a FAIL signal for a mismatch.\n`);
  const qa = new QARunner(providers,{...getWorkflowConfig(),agentDefault:'codex',qaTimeout:90000},{projectRoot:workspace, executionBaseBranch:'main',plugins,agentRuntime:runtime,onSession:event=>{
    receipt.qaSessionId = event.sessionId;
    receipt.qaProductTokens = event.usage?.totalTokens;
  }});
  const outcome = await qa.process('1');
  receipt.qaState = item.state;
  receipt.qaSuccess = outcome.success;
  receipt.qaCode = outcome.failureCode;
  const store = new JsonlEventStore({root:process.env.AFK_EVENT_STORE_DIR});
  for (const id of await store.listRuns()) {
    for await (const event of store.read(id)) {
      if (event.context.workItemId === workItemId && ['qa.failed','qa.passed'].includes(event.data.kind)) receipt.qaEvent=event.data.kind;
    }
  }
  assert.ok(outcome.success);assert.equal(receipt.qaEvent,'qa.passed');assert.equal(item.state,'merge_ready');
  assert.match(receipt.qaSessionId,/^[0-9a-f-]{36}$/);assert.notEqual(receipt.qaSessionId,receipt.sessionId);
  const nativeFiles = readdirSync(join(process.env.CODEX_HOME,'sessions'),{recursive:true});
  receipt.qaNativeThreadMatch = nativeFiles.some(name=>name.endsWith(receipt.qaSessionId+'.jsonl'));
  assert.ok(receipt.qaNativeThreadMatch);assert.ok(receipt.qaProductTokens>0);
}
