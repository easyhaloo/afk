import { describe, expect, it, vi } from 'vitest';
import { diagnoseExternalTools, listExternalTools, type VersionProbeExecutor, type VersionProbeRequest } from './external-tools.js';
import type { ExternalToolDependency, PluginManifest } from '../../plugin-sdk/profile.js';
import * as sdk from '../../plugin-sdk/index.js';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const tool: ExternalToolDependency = {
  id: 'node', command: 'node', location: 'host',
  version: { args: ['--version'], minimum: '22.16.0' }, source: { url: 'https://nodejs.org/en/download' },
};
const manifest: PluginManifest = { id: 'host.node', version: '1.0.0', apiVersion: 1, provides: ['host.connection'], trusted: true, externalTools: [tool] };
const approvedProbes = [{ command: 'node', args: ['--version'], location: 'host' as const }];
const options = { probe: true, approvedProbes, executorLifecycle: 'trusted-cooperative' as const };
const success = vi.fn(async (_request: VersionProbeRequest) => ({ stdout: 'v24.18.0\n', stderr: '' }));

describe('external tool diagnostics', () => {
  it('publishes the contract through the production plugin SDK', () => {
    expect(sdk.diagnoseExternalTools).toBe(diagnoseExternalTools);
    expect(sdk.listExternalTools).toBe(listExternalTools);
    expect(sdk.builtinExternalTools('agent.cursor')[0].command).toBe('cursor-agent');
  });

  it('lists declarations without executing anything and preserves old manifests', async () => {
    const execute = vi.fn(async (_request: VersionProbeRequest) => { throw new Error('must not run'); });
    expect(listExternalTools(manifest)).toEqual([tool]);
    expect(listExternalTools({ ...manifest, externalTools: undefined })).toEqual([]);
    expect(await diagnoseExternalTools(manifest, { execute })).toEqual([{ id: 'node', location: 'host', status: 'unknown', reason: 'not-requested' }]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires exact independent approval of the command, arguments and location', async () => {
    for (const approvedProbes of [[], [{ command: 'other', args: ['--version'], location: 'host' as const }],
      [{ command: 'node', args: ['-e', 'bad'], location: 'host' as const }],
      [{ command: 'node', args: ['--version'], location: 'backend' as const }]]) {
      const execute = vi.fn(success);
      expect(await diagnoseExternalTools(manifest, { probe: true, approvedProbes, execute })).toEqual([
        { id: 'node', location: 'host', status: 'unknown', reason: 'not-approved' },
      ]);
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it('never interprets backend tools as missing from the host PATH', async () => {
    const execute = vi.fn(success);
    const backend: PluginManifest = { ...manifest, externalTools: [{ ...tool, location: 'backend', platforms: ['linux'] }] };
    expect(await diagnoseExternalTools(backend, { ...options, execute })).toEqual([{ id: 'node', location: 'backend', status: 'unknown', reason: 'backend-required' }]);
    expect(execute).not.toHaveBeenCalled();
    expect(await diagnoseExternalTools(backend, {
      probe: true, approvedProbes: [{ ...approvedProbes[0], location: 'backend' }],
      backend: { platform: 'linux', architecture: 'x64', execute: success, lifecycle: 'trusted-cooperative' },
    })).toEqual([{ id: 'node', location: 'backend', status: 'available', version: '24.18.0' }]);
  });

  it('separates unsupported platform and architecture without probing', async () => {
    for (const declaration of [{ ...tool, platforms: ['aix'] as const }, { ...tool, architectures: ['s390'] as const }]) {
      const execute = vi.fn(success);
      expect((await diagnoseExternalTools({ ...manifest, externalTools: [declaration] } as PluginManifest, { ...options, execute }))[0].status).toBe('unsupported');
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['node v24.18.0', 'available', '24.18.0'], ['v22.16.0+build.2', 'available', '22.16.0'],
    ['node 22.15.9', 'outdated', '22.15.9'], ['v22.16.0-beta.1', 'unknown', undefined],
    ['account token=private-value', 'unknown', undefined], ['v9999999.2.3', 'unknown', undefined],
  ])('reports only safe numeric versions from %s', async (stdout, status, version) => {
    const result = (await diagnoseExternalTools(manifest, { ...options, execute: async () => ({ stdout, stderr: 'secret-value' }) }))[0];
    expect(result.status).toBe(status);
    expect(result.version).toBe(version);
    expect(JSON.stringify(result)).not.toMatch(/secret|token|private|beta|build/);
  });

  it('reads kubectl client and SSH versions without reporting secondary library versions', async () => {
    const execute: VersionProbeExecutor = async () => ({ stdout: JSON.stringify({ clientVersion: { gitVersion: 'v1.32.4', goVersion: 'go1.23.0' } }), stderr: '' });
    expect((await diagnoseExternalTools(manifest, { ...options, execute }))[0].version).toBe('1.32.4');
    expect((await diagnoseExternalTools(manifest, { ...options, execute: async () => ({ stdout: '', stderr: 'OpenSSH_9.9p2, LibreSSL 3.3.6' }) }))[0].status).toBe('unknown');
  });

  it('separates a spawn ENOENT from failures containing private messages or fake missing text', async () => {
    for (const [error, status] of [
      [Object.assign(new Error('private-path'), { code: 'ENOENT' }), 'missing'],
      [Object.assign(new Error('secret-value ENOENT'), { code: 'EACCES' }), 'unknown'],
      [new Error('secret-value not found'), 'unknown'],
    ] as const) {
      const result = await diagnoseExternalTools(manifest, { ...options, execute: async () => { throw error; } });
      expect(result[0].status).toBe(status);
      expect(JSON.stringify(result)).not.toMatch(/private|secret|EACCES|ENOENT/);
    }
  });

  it('does not execute tools with no known version probe', async () => {
    const execute = vi.fn(success);
    expect((await diagnoseExternalTools({ ...manifest, externalTools: [{ ...tool, version: undefined }] }, { ...options, execute }))[0])
      .toEqual({ id: 'node', location: 'host', status: 'unknown', reason: 'no-version-probe' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('detects a missing host command without guessing version flags or running it', async () => {
    const missing = { ...tool, command: `d01-absent-${process.pid}`, version: undefined };
    expect(await diagnoseExternalTools({ ...manifest, externalTools: [missing] }, { probe: true }))
      .toEqual([{ id: 'node', location: 'host', status: 'missing' }]);
  });

  it('enforces output and time limits on real local Node children', async () => {
    for (const [script, reason] of [
      ['process.stdout.write("x".repeat(8192))', 'output-limit'],
      ['setInterval(()=>{},1000)', 'timeout'],
    ] as const) {
      const args = ['-e', script];
      expect(await diagnoseExternalTools({ ...manifest, externalTools: [{ ...tool, version: { args } }] }, {
        probe: true, timeoutMs: reason === 'timeout' ? 150 : 3000, approvedProbes: [{ command: 'node', args, location: 'host' }],
      })).toEqual([{ id: 'node', location: 'host', status: 'unknown', reason }]);
    }
  });

  it('shares one deadline across the inventory instead of starting another timed out probe', async () => {
    const execute = vi.fn(async (_request: VersionProbeRequest): ReturnType<VersionProbeExecutor> => new Promise(() => {}));
    const result = await diagnoseExternalTools({ ...manifest, externalTools: [tool, { ...tool, id: 'second' }] }, {
      ...options, timeoutMs: 20, execute,
    });
    expect(result.map(result => result.reason)).toEqual(['timeout', 'timeout']);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('bounds output and cancels a hanging controlled executor by the overall deadline', async () => {
    const huge = await diagnoseExternalTools(manifest, { ...options, execute: async () => ({ stdout: 'v24.18.0' + 'x'.repeat(4096), stderr: '' }) });
    expect(huge[0]).toEqual({ id: 'node', location: 'host', status: 'unknown', reason: 'output-limit' });
    let signal: AbortSignal | undefined;
    const hanging = await diagnoseExternalTools(manifest, { ...options, timeoutMs: 20, execute: async request => {
      signal = request.signal;
      return new Promise(() => {});
    } });
    expect(hanging[0]).toEqual({ id: 'node', location: 'host', status: 'unknown', reason: 'timeout', cleanup: 'unconfirmed' });
    expect(signal?.aborted).toBe(true);
  });

  it('rejects invalid limits and honours pre-cancellation without execution', async () => {
    for (const timeoutMs of [0, -1, NaN, Infinity, 5001]) {
      await expect(diagnoseExternalTools(manifest, { ...options, timeoutMs, execute: success })).rejects.toThrow(/timeout/);
    }
    const execute = vi.fn(success);
    expect((await diagnoseExternalTools(manifest, { ...options, execute, signal: AbortSignal.abort('private cancellation') }))[0].reason).toBe('cancelled');
    expect(execute).not.toHaveBeenCalled();
  });

  it('runs only the local Node version using the production bounded executor', async () => {
    const result = await diagnoseExternalTools(manifest, options);
    expect(result).toEqual([{ id: 'node', location: 'host', status: 'available', version: process.versions.node }]);
  });

  it('uses an empty home and working directory and strips inherited credentials and Node hooks', async () => {
    const args = ['-e', 'const fs=require("fs");if(!process.env.D01_SECRET&&!process.env.NODE_OPTIONS&&fs.readdirSync(process.cwd()).length===0&&process.cwd()===process.env.HOME)console.log("1.2.3");'];
    const previous = process.env.D01_SECRET;
    const previousNodeOptions = process.env.NODE_OPTIONS;
    process.env.D01_SECRET = 'private-value';
    process.env.NODE_OPTIONS = '--require=d01-must-never-load';
    try {
      const result = await diagnoseExternalTools({ ...manifest, externalTools: [{ ...tool, version: { args } }] }, {
        probe: true, approvedProbes: [{ command: 'node', args, location: 'host' }],
      });
      expect(result).toEqual([{ id: 'node', location: 'host', status: 'available', version: '1.2.3' }]);
    } finally {
      if (previous === undefined) delete process.env.D01_SECRET;
      else process.env.D01_SECRET = previous;
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousNodeOptions;
    }
  });

  it('requires custom and backend executors to declare a trusted cooperative lifecycle', async () => {
    const execute = vi.fn(success);
    expect(await diagnoseExternalTools(manifest, { probe: true, approvedProbes, execute }))
      .toEqual([{ id: 'node', location: 'host', status: 'unknown', reason: 'executor-untrusted' }]);
    expect(await diagnoseExternalTools({ ...manifest, externalTools: [{ ...tool, location: 'backend' }] }, {
      probe: true, approvedProbes: [{ ...approvedProbes[0], location: 'backend' }],
      backend: { platform: 'linux', architecture: 'x64', execute },
    })).toEqual([{ id: 'node', location: 'backend', status: 'unknown', reason: 'executor-untrusted' }]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('waits for a trusted custom executor to finish cancellation cleanup without publishing late success', async () => {
    const controller = new AbortController();
    let cleaned = false;
    const result = await diagnoseExternalTools(manifest, { ...options, signal: controller.signal, execute: request => new Promise(resolve => {
      request.signal.addEventListener('abort', () => setTimeout(() => {
        cleaned = true;
        resolve({ stdout: 'v99.0.0', stderr: '' });
      }, 20), { once: true });
      controller.abort();
    }) });
    expect(cleaned).toBe(true);
    expect(result).toEqual([{ id: 'node', location: 'host', status: 'unknown', reason: 'cancelled' }]);
  });

  it('reports unconfirmed cleanup when a trusted backend does not cooperate without falling back to host execution', async () => {
    const execute = vi.fn(async (_request: VersionProbeRequest): ReturnType<VersionProbeExecutor> => new Promise(() => {}));
    const hostExecute = vi.fn(success);
    expect(await diagnoseExternalTools({ ...manifest, externalTools: [{ ...tool, location: 'backend' }] }, {
      probe: true, timeoutMs: 20, execute: hostExecute, executorLifecycle: 'trusted-cooperative',
      approvedProbes: [{ ...approvedProbes[0], location: 'backend' }],
      backend: { platform: 'linux', architecture: 'x64', execute, lifecycle: 'trusted-cooperative' },
    })).toEqual([{ id: 'node', location: 'backend', status: 'unknown', reason: 'timeout', cleanup: 'unconfirmed' }]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(hostExecute).not.toHaveBeenCalled();
  });

  it.each([
    ['host', 'cancelled'], ['host', 'timeout'], ['backend', 'cancelled'], ['backend', 'timeout'],
  ] as const)('preserves delayed cleanup failure after %s %s', async (location, reason) => {
    const controller = new AbortController();
    let started: () => void = () => undefined;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const execute: VersionProbeExecutor = request => {
      started();
      return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => setTimeout(() => {
        reject(Object.assign(new Error('private cleanup failure'), { code: 'PROBE_CLEANUP_UNCONFIRMED' }));
      }, 20), { once: true }));
    };
    const pending = diagnoseExternalTools({ ...manifest, externalTools: [{ ...tool, location }] }, {
      ...options, signal: controller.signal, timeoutMs: reason === 'timeout' ? 30 : 1000,
      approvedProbes: [{ ...approvedProbes[0], location }],
      ...(location === 'host' ? { execute } : {
        backend: { platform: process.platform, architecture: process.arch, lifecycle: 'trusted-cooperative', execute },
      }),
    });
    await ready;
    if (reason === 'cancelled') controller.abort('private cancellation');
    expect(await pending).toEqual([{ id: 'node', location, status: 'unknown', reason, cleanup: 'unconfirmed' }]);
  });

  it.each(['cancelled', 'timeout', 'resistant-cancelled', 'resistant-timeout', 'output-limit', 'continuous-cancelled', 'continuous-timeout'])(
    'closes the actual owned Node PID before removing cwd and returning for %s', async kind => {
      const directory = await mkdtemp(join(tmpdir(), 'afk-tool-lifecycle-test-'));
      try {
        const childScript = join(directory, 'child.cjs');
        await writeFile(childScript, `const fs=require('node:fs');const path=require('node:path');
          ${kind.startsWith('resistant') || kind.startsWith('continuous') || kind === 'output-limit' ? "process.on('SIGTERM',()=>{});" : ''}
          fs.writeFileSync(path.join(__dirname,'ready'),String(process.pid));
          ${kind === 'output-limit' ? "process.stdout.write('x'.repeat(8192));" : ''}
          setInterval(()=>{${kind.startsWith('continuous') ? "process.stdout.write('x');" : ''}},10);`);
        const script = `import assert from 'node:assert/strict';
          import cp from 'node:child_process';import fs from 'node:fs';import fsp from 'node:fs/promises';
          import {syncBuiltinESMExports} from 'node:module';
          const events=[];let child,cwd,closed=false;const originalExec=cp.execFile,originalRm=fsp.rm;
          cp.execFile=(command,args,options,callback)=>{
            cwd=options.cwd;child=originalExec(command,args,options,callback);
            child.on('close',()=>{closed=true;events.push('close');});return child;
          };
          fsp.rm=async(path,options)=>{if(path===cwd)events.push('rm-start');await originalRm(path,options);if(path===cwd)events.push('rm-done');};
          syncBuiltinESMExports();
          const {diagnoseExternalTools}=await import(${JSON.stringify(new URL('./external-tools.ts', import.meta.url).href)});
          const args=[${JSON.stringify(childScript)}];const stop=new AbortController();
          const manifest={id:'host.node',version:'1.0.0',apiVersion:1,provides:[],trusted:true,externalTools:[
            {id:'node',command:'node',location:'host',version:{args},source:{url:'https://nodejs.org'}}]};
          const observable=()=>{try{process.kill(child.pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
          try {
            const pending=diagnoseExternalTools(manifest,{probe:true,approvedProbes:[{command:'node',args,location:'host'}],signal:stop.signal,timeoutMs:400});
            const until=Date.now()+3000;while(!fs.existsSync(${JSON.stringify(join(directory, 'ready'))})){assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,2));}
            if(${JSON.stringify(kind)}.endsWith('cancelled'))stop.abort();
            const result=await pending;events.push('return');
            assert.equal(closed,true,JSON.stringify(events));assert.equal(observable(),false);
            assert.equal(fs.existsSync(cwd),false);assert.ok(events.indexOf('close')<events.indexOf('rm-start'));
            assert.ok(events.indexOf('rm-done')<events.indexOf('return'));
            assert.equal(result[0].reason,${JSON.stringify(kind.endsWith('cancelled') ? 'cancelled' : kind.endsWith('timeout') ? 'timeout' : 'output-limit')});
            assert.equal(result[0].cleanup,undefined);assert.equal(child.signalCode,'SIGKILL');
            console.log(JSON.stringify(events));
          } finally {if(child&&observable()){child.kill('SIGKILL');await new Promise(r=>child.once('close',r));}}`;
        const { stdout } = await promisify(execFile)(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), '--input-type=module', '-e', script], {
          timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
        });
        expect(JSON.parse(stdout)).toEqual(['close', 'rm-start', 'rm-done', 'return']);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
