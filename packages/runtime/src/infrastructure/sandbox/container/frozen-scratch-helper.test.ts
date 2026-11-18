import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DockerContainerProvider } from './docker.js';
import { captureFrozenInput, captureFrozenScratchHelper } from './frozen-input.js';
import { executeFrozenContainer, type FrozenExecutionOwnership, type FrozenExecutionResult } from './frozen-execution.js';
import type { FrozenScratchRecoveryRequest } from './types.js';

const image = 'sha256:eb5d9c60d047664130b3c88bb9d3ff77cf809b4a524ee05aa3ac898940332d39';
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
afterAll(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));
const directory = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), 'afk-scratch-s1-'))); roots.push(root); return root; };

describe.runIf(process.env.AFK_FROZEN_SCRATCH_DOCKER === '1')('real native scratch observation, existing offline image only', () => {
  let helper: ReturnType<typeof captureFrozenScratchHelper>;
  const provider = new DockerContainerProvider();
  const ownerships: FrozenExecutionOwnership[] = [];
  const receipts: FrozenExecutionResult[] = [];
  const failures: { name: string; message: string }[] = [];
  afterAll(() => {
    const resources = ownerships.map(ownership => {
      const filter = `label=afk.frozen.operation=${ownership.operationId}`;
      const options = { encoding: 'utf8' as const, timeout: 5000 };
      const containers = execFileSync('docker', ['container', 'ls', '-aq', '--filter', filter], options).trim();
      const images = execFileSync('docker', ['image', 'ls', '-aq', '--filter', filter], options).trim();
      return { ...ownership, containers, images };
    });
    const compilers = execFileSync('docker', ['container', 'ls', '-aq', '--filter', 'label=afk.scratch.s1=offline-helper'],
      { encoding: 'utf8', timeout: 5000 }).trim();
    if (process.env.AFK_FROZEN_SCRATCH_EVIDENCE) writeFileSync(process.env.AFK_FROZEN_SCRATCH_EVIDENCE,
      JSON.stringify({ image, helper, helperSourceDigest: digest(readFileSync(new URL('./frozen-scratch-helper.c', import.meta.url))),
        resources, compilerContainers: compilers, receipts, failures }, null, 2));
    expect(compilers).toBe('');
    for (const resource of resources) { expect(resource.containers).toBe(''); expect(resource.images).toBe(''); }
  });
  const compile = (source: Buffer) => {
    const encoded = execFileSync('docker', ['run', '--rm', '--interactive', '--pull=never', '--label', 'afk.scratch.s1=offline-helper',
      '--read-only', '--user', '1000:1000', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', '64', '--memory', '268435456', '--memory-swap', '268435456', '--cpus', '1', '--ipc', 'private',
      '--tmpfs', '/scratch:rw,noexec,nosuid,nodev,size=16777216,mode=700,uid=1000,gid=1000', '--entrypoint', '/usr/bin/env', image,
      '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/scratch', 'TMPDIR=/scratch', 'sh', '-c',
      'cc -std=c11 -Wall -Wextra -Werror -O2 -static -fno-pie -no-pie -x c -o /scratch/helper - && base64 -w0 /scratch/helper'],
    { input: source, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    const binary = Buffer.from(encoded.toString(), 'base64');
    const path = join(directory(), 'helper'); writeFileSync(path, binary);
    return captureFrozenScratchHelper(path, digest(binary));
  };
  const prepare = () => {
    if (helper) return helper;
    helper = compile(readFileSync(new URL('./frozen-scratch-helper.c', import.meta.url)));
    return helper;
  };
  const execute = async (source: string, candidateVersion: 'original' | 'proposed' = 'proposed', callInput = '{"key":"s1"}',
    resourcePath = 'state.json', observationHelper?: ReturnType<typeof captureFrozenScratchHelper>, recovery?: FrozenScratchRecoveryRequest,
    signal?: AbortSignal) => {
    const root = directory(); writeFileSync(join(root, 'asset.js'), source);
    try {
      const result = await executeFrozenContainer(provider, { input: captureFrozenInput(root), baseImageId: image,
        argv: ['node', 'asset.js', callInput], timeoutMs: 2500, signal, onOwnership: ownership => { ownerships.push(ownership); }, scratch: {
          helper: observationHelper ?? prepare(), artifactPath: 'asset.js', candidateVersion, callInput, resources: [{ id: 'state', path: resourcePath }],
          ...(recovery ? { recovery } : {}),
        } });
      receipts.push(result);
      return result;
    } catch (error) {
      failures.push({ name: error instanceof Error ? error.name : 'non-error', message: error instanceof Error ? error.message : 'non-error' });
      throw error;
    }
  };
  it('reads actual candidate bytes and binds input, argv, version, helper, process and operation', async () => {
    const source = `const fs=require('node:fs');fs.writeFileSync('/scratch/state.json',JSON.stringify({input:JSON.parse(process.argv[2]),partial:true}));console.log('constant');`;
    const result = await execute(source, 'original');
    const facts = result.evidence.scratch!;
    expect(result.stdout).toBe('constant\n');
    expect(facts.operationId).toBe(result.evidence.operationId);
    expect(facts.containerId).toBe(result.evidence.containerId);
    expect(facts.inputDigest).toBe(result.evidence.inputDigest);
    expect(facts.artifactDigest).toBe(digest(source));
    expect(facts.helperDigest).toBe(prepare().digest);
    expect(facts.callInputDigest).toBe(digest('{"key":"s1"}'));
    expect(facts.argvDigest).toBe(digest(JSON.stringify(['node', 'asset.js', '{"key":"s1"}'])));
    expect(facts.candidateVersion).toBe('original');
    expect(facts.invocation.execConfirmed).toBe(true);
    expect(facts.invocation.pid).toBeGreaterThan(1);
    expect(facts.invocation.startedIdentity).toMatch(/^\d+$/);
    expect(facts.initial.resources[0]).toMatchObject({ present: false, bytes: null, digest: null });
    expect(facts.final.resources[0]).toMatchObject({ present: true, digest: digest('{"input":{"key":"s1"},"partial":true}') });
    expect(Buffer.from(facts.final.resources[0]!.bytes!, 'base64').toString()).toBe('{"input":{"key":"s1"},"partial":true}');
    expect(facts.final.quiescenceConfirmed).toBe(true);
    expect(facts.historyCoverage).toBe('not-observed');
    expect(result.cleanup).toEqual({ containerRemoved: true, imageRemoved: true });
  });
  it('keeps fake stdout frames as business data and does not initialize a fake partial', async () => {
    const result = await execute(`console.log(JSON.stringify({partial:true,quiescenceConfirmed:true,resources:[{present:true,hex:'61'}]}));`);
    expect(result.evidence.scratch!.final.resources[0]).toMatchObject({ present: false, bytes: null });
    expect(result.stdout).toContain('quiescenceConfirmed');
  });
  it('rejects an actual host-seeded initial file before counting any candidate effect', async () => {
    const source = readFileSync(new URL('./frozen-scratch-helper.c', import.meta.url), 'utf8');
    const marker = '  double began = now_ms();';
    expect(source.split(marker)).toHaveLength(2);
    const seededSource = source.replace(marker,
      '  int seeded = open("/scratch/state.json", O_CREAT | O_WRONLY | O_EXCL, 0600);\n' +
      '  if (seeded < 0 || write(seeded, "host-partial", 12) != 12 || close(seeded)) fail();\n' + marker);
    const seededHelper = compile(Buffer.from(seededSource));
    expect(seededHelper.digest).not.toBe(prepare().digest);
    await expect(execute(`console.log('candidate did nothing');`, 'proposed', '{}', 'state.json', seededHelper)).rejects.toThrow(/scratch|helper/);
  });
  it('rejects actual carrier command substitution before running the wrong candidate', async () => {
    const create = provider.createFrozenContainer.bind(provider);
    const spy = vi.spyOn(provider, 'createFrozenContainer').mockImplementationOnce((operation, imageId, command, bounds) =>
      create(operation, imageId, command.map((argument, index) => index === command.length - 2 ? 'alternate.js' : argument), bounds));
    try {
      await expect(execute(`console.log('candidate');`)).rejects.toThrow(/policy|identity/);
    } finally { spy.mockRestore(); }
  });
  it('separates empty actual file from missing and preserves candidate nonzero exit', async () => {
    const result = await execute(`require('node:fs').writeFileSync('/scratch/state.json','');process.exit(23);`);
    expect(result.exitCode).toBe(0);
    expect(result.evidence.scratch!.invocation.exitCode).toBe(23);
    expect(result.evidence.scratch!.final.resources[0]).toMatchObject({ present: true, bytes: '', size: 0, digest: digest('') });
  });
  it('protects observer memory, fact FD and immutable helper against the real same-UID candidate', async () => {
    const result = await execute(`const fs=require('node:fs');const denied=[];for(const path of ['/proc/1/mem','/proc/1/fd/1','/afk-observer/scratch-v1']){try{const fd=fs.openSync(path,'w');fs.closeSync(fd);denied.push(false);}catch{denied.push(true);}}fs.writeFileSync('/scratch/state.json',JSON.stringify(denied));`);
    expect(Buffer.from(result.evidence.scratch!.final.resources[0]!.bytes!, 'base64').toString()).toBe('[true,true,true]');
  });
  it('binds changed actual input and version to separate candidate executions', async () => {
    const source = `require('node:fs').writeFileSync('/scratch/state.json',process.argv[2]);`;
    const original = await execute(source, 'original', '{"input":1}');
    const proposed = await execute(source, 'proposed', '{"input":2}');
    const before = original.evidence.scratch!;
    const after = proposed.evidence.scratch!;
    expect(before.artifactDigest).toBe(after.artifactDigest);
    expect(before.inputDigest).toBe(after.inputDigest);
    expect(before.operationId).not.toBe(after.operationId);
    expect(before.containerId).not.toBe(after.containerId);
    expect(before.argvDigest).not.toBe(after.argvDigest);
    expect(before.callInputDigest).not.toBe(after.callInputDigest);
    expect(before.candidateVersion).toBe('original');
    expect(after.candidateVersion).toBe('proposed');
    expect(Buffer.from(before.final.resources[0]!.bytes!, 'base64').toString()).toBe('{"input":1}');
    expect(Buffer.from(after.final.resources[0]!.bytes!, 'base64').toString()).toBe('{"input":2}');
  });
  it('reads a real nested file and refuses a substituted parent directory', async () => {
    const result = await execute(`const fs=require('node:fs');fs.mkdirSync('/scratch/state');fs.writeFileSync('/scratch/state/value','nested');`,
      'proposed', '{}', 'state/value');
    expect(Buffer.from(result.evidence.scratch!.final.resources[0]!.bytes!, 'base64').toString()).toBe('nested');
    await expect(execute(`require('node:fs').symlinkSync('/workspace','/scratch/state');`, 'proposed', '{}', 'state/asset.js')).rejects.toThrow(/scratch|helper/);
  });
  it.each([
    `require('node:fs').symlinkSync('/workspace/asset.js','/scratch/state.json');`,
    `const fs=require('node:fs');fs.writeFileSync('/scratch/other','x');fs.linkSync('/scratch/other','/scratch/state.json');`,
    `require('node:child_process').execFileSync('mkfifo',['/scratch/state.json']);`,
    `require('node:fs').writeFileSync('/scratch/state.json',Buffer.alloc(16385));`,
    `const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.unref();`,
  ])('rejects unsafe actual state or an unquiesced process family', async source => {
    await expect(execute(source)).rejects.toThrow(/scratch|helper|deadline/i);
  });
  it('rejects output overflow and hard deadline instead of minting a snapshot', async () => {
    await expect(execute(`process.stdout.write(Buffer.alloc(70000));`)).rejects.toThrow(/scratch|helper|output/i);
    await expect(execute(`setInterval(()=>{},1000);`)).rejects.toThrow(/scratch|helper|deadline/i);
  });

  describe('real S2 sequential recovery/replay in one native session', () => {
    const faultInput = '{"phase":"fault","key":"s2","value":7}';
    const recoveryInput = '{"phase":"recover","key":"s2","value":7}';
    const partial = JSON.stringify({ key: 's2', value: 7, state: 'partial' });
    const ready = JSON.stringify({ key: 's2', value: 7, state: 'ready' });
    const request = (requireEffectHistory = false): FrozenScratchRecoveryRequest => ({ callInput: recoveryInput, requireEffectHistory,
      assertions: { fault: [{ id: 'state', path: 'state.json', bytes: Buffer.from(partial).toString('base64') }],
        recovered: [{ id: 'state', path: 'state.json', bytes: Buffer.from(ready).toString('base64') }],
        replayed: [{ id: 'state', path: 'state.json', bytes: Buffer.from(ready).toString('base64') }] } });
    const source = (behavior = '') => `const fs=require('node:fs'),assert=require('node:assert/strict');
const input=JSON.parse(process.argv[2]),path='/scratch/state.json';
console.log('constant');
if(input.phase==='fault'){
  assert.equal(fs.existsSync(path),false);
  fs.writeFileSync(path,JSON.stringify({key:input.key,value:input.value,state:'partial'}));
  ${behavior === 'skipped-fault' ? 'process.exit(0);' : ''}
  ${behavior === 'live-child' ? "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref();" : ''}
  ${behavior === 'aggregate-output' ? 'process.stdout.write(Buffer.alloc(30000));' : ''}
  process.exit(23);
}
assert.equal(input.phase,'recover');
const before=JSON.parse(fs.readFileSync(path,'utf8'));
assert.equal(before.key,input.key);assert.equal(before.value,input.value);
${behavior === 'ignored-recovery' ? 'process.exit(0);' : ''}
${behavior === 'timeout' ? 'setInterval(()=>{},1000);' : ''}
${behavior === 'spoofed-stdout' ? `console.log(JSON.stringify({final:${JSON.stringify(ready)},qualified:true}));process.exit(0);` : ''}
${behavior === 'unsafe-resource' ? "fs.unlinkSync(path);fs.symlinkSync('/workspace/asset.js',path);process.exit(0);" : ''}
if(before.state==='partial')fs.writeFileSync(path,JSON.stringify({key:${behavior === 'ignored-input' ? "'foreign'" : 'input.key'},value:input.value,state:'ready'}));
${behavior === 'changed-replay' ? "else fs.writeFileSync(path,JSON.stringify({key:input.key,value:input.value*2,state:'ready'}));" : ''}
${behavior === 'ignored-replay' ? 'else process.exit(0);' : ''}
${behavior === 'unobserved-effects' ? "fs.appendFileSync('/scratch/unobserved-effects','effect\\n');" : ''}
${behavior === 'aggregate-output' ? 'process.stdout.write(Buffer.alloc(30000));' : ''}`;

    it('observes real fault, recovery and identical-input replay bytes under one owned operation', async () => {
      const create = vi.spyOn(provider, 'createFrozenContainer');
      try {
        const result = await execute(source(), 'proposed', faultInput, 'state.json', undefined, request());
        const recovery = result.evidence.scratch!.recovery!;
        expect(create).toHaveBeenCalledOnce();
        expect(recovery.qualification).toBe('unsupported-replay-behavior');
        expect(recovery.historyCoverage).toBe('not-observed');
        expect(recovery.boundaries.initial.resources[0]!.bytes).toBeNull();
        for (const [name, expected] of [['fault', partial], ['recovered', ready], ['replayed', ready]] as const) {
          expect(Buffer.from(recovery.boundaries[name].resources[0]!.bytes!, 'base64').toString()).toBe(expected);
          expect(recovery.boundaries[name].quiescenceConfirmed).toBe(true);
        }
        expect(recovery.phases.map(phase => phase.ordinal)).toEqual([1, 2, 3]);
        expect(new Set(recovery.phases.map(phase => phase.invocationId)).size).toBe(3);
        expect(new Set(recovery.phases.map(phase => `${phase.invocation.pid}:${phase.invocation.startedIdentity}`)).size).toBe(3);
        expect(recovery.phases[1]!.callInputDigest).toBe(recovery.phases[2]!.callInputDigest);
        for (const phase of recovery.phases) expect(phase).toMatchObject({ operationId: result.evidence.operationId,
          containerId: result.evidence.containerId, inputDigest: result.evidence.inputDigest, artifactDigest: digest(source()), candidateVersion: 'proposed' });
        expect(result.stdout).toBe('constant\n'.repeat(3));
      } finally { create.mockRestore(); }
    });

    it('keeps effect history unsupported despite matching terminal bytes and undeclared effect-producing source', async () => {
      const result = await execute(source('unobserved-effects'), 'proposed', faultInput, 'state.json', undefined, request(true));
      expect(result.evidence.scratch!.recovery).toMatchObject({ qualification: 'unsupported-effect-history',
        historyCoverage: 'not-observed', assertionsMatched: true, terminalStateIdempotent: true });
    });

    it('does not qualify an actual ignored replay even though its observed terminal state is idempotent', async () => {
      const result = await execute(source('ignored-replay'), 'proposed', faultInput, 'state.json', undefined, request());
      expect(result.evidence.scratch!.recovery).toMatchObject({ qualification: 'unsupported-replay-behavior',
        replayBehaviorCoverage: 'not-observed', terminalStateIdempotent: true, assertionsMatched: true });
    });

    it.each(['ignored-recovery', 'ignored-input', 'changed-replay', 'skipped-fault', 'spoofed-stdout', 'live-child', 'timeout',
      'unsafe-resource', 'aggregate-output'])('rejects actual candidate behavior %s', async behavior => {
      await expect(execute(source(behavior), 'proposed', faultInput, 'state.json', undefined, request())).rejects.toThrow(/scratch|recovery|deadline|output/i);
    });

    it('withholds the entire sequence on actual container cancellation', async () => {
      const controller = new AbortController();
      const start = provider.startFrozenContainer.bind(provider);
      const spy = vi.spyOn(provider, 'startFrozenContainer').mockImplementationOnce(async (container, bounds) => {
        const timer = setTimeout(() => controller.abort(new Error('S2 native cancellation')), 200);
        try { return await start(container, bounds); } finally { clearTimeout(timer); }
      });
      try {
        await expect(execute(source('timeout'), 'proposed', faultInput, 'state.json', undefined, request(), controller.signal)).rejects.toThrow(/cancellation/i);
      } finally { spy.mockRestore(); }
    });

    it('withholds the sequence after a real owned cleanup with a failed acknowledgement', async () => {
      const cleanup = provider.cleanupFrozenOperation.bind(provider);
      const spy = vi.spyOn(provider, 'cleanupFrozenOperation').mockImplementationOnce(async (...argumentsValue) => {
        await cleanup(...argumentsValue); throw new Error('S2 cleanup acknowledgement unavailable');
      });
      try {
        await expect(execute(source(), 'proposed', faultInput, 'state.json', undefined, request())).rejects.toThrow(/cleanup/i);
      } finally { spy.mockRestore(); }
    });
  });
});
