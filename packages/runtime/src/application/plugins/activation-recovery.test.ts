import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Run the installed files with Node, including its real ESM dependency cache.
const modules = fileURLToPath(new URL('../../../dist/application/plugins/', import.meta.url));
const fixture = `
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const base = pathToFileURL(${JSON.stringify(modules)} + '/');
const { PluginManager, readInstalledPlugin } = await import(new URL('manager.js', base));
const { loadInstalledPlugins } = await import(new URL('loader.js', base));
const { PluginRuntime } = await import(new URL('runtime.js', base));
const { readPluginConfiguration } = await import(new URL('configuration.js', base));
const root = await fs.mkdtemp(join(tmpdir(), 'activation-recovery-'));
const homeDir = join(root, 'home'), source = join(root, 'source');
const directory = join(homeDir, '.afk', 'plugins', 'context.recovery');
const manager = new PluginManager({ homeDir, runNpm: async () => { throw Error('npm forbidden'); } });
let runtime;
async function write(version, failure = '') {
  await fs.mkdir(source, { recursive: true });
  const manifest = { id: 'context.recovery', version, apiVersion: 1, trusted: true, provides: ['context.provider'] };
  await fs.writeFile(join(source, 'package.json'), JSON.stringify({ type: 'module' }));
  await fs.writeFile(join(source, 'plugin.json'), JSON.stringify({ ...manifest, entry: 'index.mjs' }));
  await fs.writeFile(join(source, 'dependency.mjs'), 'export default ' + JSON.stringify(version));
  await fs.writeFile(join(source, 'index.mjs'), \`
    import value from './dependency.mjs';
    import { writeFileSync } from 'node:fs';
    \${failure === 'import' ? 'throw Error("v2 import failed");' : ''}
    export default () => {
      \${failure === 'factory' ? 'throw Error("v2 factory failed");' : ''}
      return { manifest: \${JSON.stringify(manifest)}, activate(ctx) {
        ctx.onDispose(() => { globalThis.recoveryDisposals = (globalThis.recoveryDisposals ?? 0) + 1; });
        ctx.registerContextProvider('recovery', { id: 'recovery', gather: async () => [{ origin: 'test', content: value }] });
        \${failure === 'activate' ? 'throw Error("v2 activate failed");' : ''}
        \${failure === 'crash' ? 'if (!globalThis.recoveryAllow) process.exit(0); throw Error("interrupted activation");' : ''}
        \${failure === 'concurrent' ? 'writeFileSync(' + JSON.stringify(join(homeDir, '.afk', 'plugins.yml')) + ', JSON.stringify({plugins:[{id:"context.recovery",enabled:true,builtin:false,config:{concurrent:true}}]}));' : ''}
      } };
    };
  \`);
}
async function load() { runtime = new PluginRuntime(); return loadInstalledPlugins(runtime, { homeDir }); }
async function value() { return (await runtime.getContextProvider('recovery').gather({ scope: 'project', prompt: 'test' }))[0].content; }
async function v1() {
  await write('1.0.0'); await manager.install(source);
  assert.deepEqual(await load(), ['context.recovery']); assert.equal(await value(), '1.0.0');
  await runtime.dispose(); globalThis.recoveryDisposals = 0;
}
async function journal() {
  const parent = join(homeDir, '.afk', 'plugins');
  const path = join(parent, '.pending-context.recovery.json');
  return { parent, path, pending: JSON.parse(await fs.readFile(path, 'utf8')) };
}
function child(body) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', body], {encoding:'utf8',timeout:10000});
  assert.equal(result.stderr, ''); assert.equal(result.status, 0); return result.stdout;
}
try {
`;
const end = `
} finally { if (runtime) await runtime.dispose(); await fs.rm(root, { recursive: true, force: true }); }
`;

function run(body: string): void {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', fixture + body + end], { encoding: 'utf8', timeout: 20_000 });
  expect(result.stderr, result.stdout).toBe('');
  expect(result.status, result.stderr).toBe(0);
}

const resourcePlugin = `
const { fstatSync } = await import('node:fs');
const owned = join(root, 'owned-resource'), independent = join(root, 'independent-resource');
globalThis.cleanupState = { allow: false, calls: {}, fd: undefined };
async function writeResource(version, activationFails = false) {
  await write(version);
  const manifest = {id:'context.recovery',version,apiVersion:1,trusted:true,provides:['context.provider']};
  await fs.writeFile(join(source,'index.mjs'), \`
    import {openSync,closeSync,unlinkSync,writeSync} from 'node:fs';
    export default {manifest:\${JSON.stringify(manifest)},activate(context) {
      const state=globalThis.cleanupState,version=\${JSON.stringify(version)};
      const calls=state.calls[version]??={resource:0,independent:0};
      const fd=openSync(\${JSON.stringify(owned)},'wx'); state.fd=fd; writeSync(fd,version);
      const other=openSync(\${JSON.stringify(independent)},'wx');
      context.onDispose(()=>{calls.independent++;closeSync(other);unlinkSync(\${JSON.stringify(independent)});});
      context.onDispose(()=>{calls.resource++;if(version==='2.0.0'&&!state.allow)throw Error('RESOURCE_CLEANUP_UNCONFIRMED');closeSync(fd);unlinkSync(\${JSON.stringify(owned)});state.fd=undefined;});
      context.registerContextProvider('recovery',{id:'recovery',gather:async()=>[{origin:'test',content:version}]});
      \${activationFails ? 'throw Error("V2_ACTIVATION_ORIGINAL");' : ''}
    }};
  \`);
}
async function resourceV1() {
  await writeResource('1.0.0');await manager.install(source);await load();assert.equal(await value(),'1.0.0');await runtime.dispose();
}
`;

describe('durable activation recovery (native Node)', () => {
  it.each(['import', 'factory', 'activate'])('restores callable v1 after v2 %s failure', failure => run(`
    await v1(); await write('2.0.0', '${failure}'); await manager.install(source);
    assert.equal(globalThis.recoveryDisposals, 0, 'install must not execute v2');
    assert.deepEqual(await load(), ['context.recovery']);
    assert.equal(await value(), '1.0.0');
    assert.equal((await readInstalledPlugin(directory)).version, '1.0.0');
    assert.equal(globalThis.recoveryDisposals, ${failure === 'activate' ? 1 : 0});
    assert((await runtime.diagnostics()).some(d => d.code === 'load.recovered'));
    assert((await runtime.diagnostics()).some(d => d.code === 'load.failed'));
  `));

  it('confirms v2 only after activation and invalidates relative dependency cache', () => run(`
    await v1(); await write('2.0.0'); await manager.install(source);
    const plugins = join(homeDir, '.afk', 'plugins');
    assert((await fs.readdir(plugins)).some(n => n.startsWith('.previous-')));
    assert.deepEqual(await load(), ['context.recovery']); assert.equal(await value(), '2.0.0');
    assert(!(await fs.readdir(plugins)).some(n => n.startsWith('.previous-')));
  `));

  it('keeps a failed first installation unloaded and diagnostic', () => run(`
    await write('2.0.0', 'activate'); await manager.install(source);
    assert.deepEqual(await load(), []); assert.equal(runtime.getContextProvider('recovery'), undefined);
    assert.equal(globalThis.recoveryDisposals, 1);
    assert((await runtime.diagnostics()).some(d => d.code === 'load.failed'));
  `));

  it('refuses upgrade and uninstall while an installed runtime owns a reference', () => run(`
    await write('1.0.0'); await manager.install(source); await load();
    await write('2.0.0');
    await assert.rejects(manager.install(source), /active|reference/i);
    await assert.rejects(manager.remove('context.recovery'), /active|reference/i);
    assert.equal(await value(), '1.0.0');
  `));

  it.each(['prepared-before-rename', 'prepared-between-renames', 'published', 'restoring', 'restored-before-config'])('recovers persistent %s with a fresh manager', phase => run(`
    await v1(); await write('2.0.0', 'import'); await manager.install(source);
    const { parent, path, pending } = await journal();
    if ('${phase}' !== 'published') {
      pending.phase = '${phase}'.startsWith('prepared') ? 'prepared' : 'restoring';
      await fs.rm(directory, { recursive: true });
      if ('${phase}' === 'prepared-before-rename' || '${phase}' === 'restored-before-config') await fs.rename(join(parent, pending.backup), directory);
      await fs.writeFile(path, JSON.stringify(pending));
    }
    assert.deepEqual(await load(), ['context.recovery']); assert.equal(await value(), '1.0.0');
    assert.equal((await readInstalledPlugin(directory)).version, '1.0.0');
  `));

  it('preserves unrelated concurrent configuration during recovery', () => run(`
    await v1(); await write('2.0.0', 'factory'); await manager.install(source);
    const path = join(homeDir, '.afk', 'plugins.yml');
    const config = readPluginConfiguration(homeDir);
    config.extra = { concurrent: true }; config.plugins.push({ id: 'context.other', enabled: false, config: { untouched: 42 } });
    await fs.writeFile(path, JSON.stringify(config));
    await load(); assert.equal(await value(), '1.0.0');
    assert.deepEqual(readPluginConfiguration(homeDir).extra, { concurrent: true });
    assert.deepEqual(readPluginConfiguration(homeDir).plugins[1].config, { untouched: 42 });
  `));

  it('refuses to overwrite concurrent settings for the recovering plugin', () => run(`
    await v1(); await write('2.0.0', 'factory'); await manager.install(source);
    await manager.configure('context.recovery', { concurrent: true });
    assert.deepEqual(await load(), []);
    assert.deepEqual(readPluginConfiguration(homeDir).plugins[0].config, { concurrent: true });
    assert.equal((await readInstalledPlugin(directory)).version, '2.0.0');
    assert((await runtime.diagnostics()).some(d => d.code === 'load.recovery-failed'));
  `));

  it.each(['plugin-id', 'digest', 'foreign-path', 'missing-backup', 'missing-destination'])('refuses tampered %s without claiming recovery', change => run(`
    await v1(); await write('2.0.0', 'factory'); await manager.install(source);
    const { parent, path, pending } = await journal();
    if ('${change}' === 'plugin-id') pending.id = 'context.other';
    if ('${change}' === 'digest') pending.previous.integrity = 'sha256-wrong';
    if ('${change}' === 'foreign-path') pending.backup = '../foreign';
    if ('${change}' === 'missing-backup') await fs.rm(join(parent, pending.backup), { recursive: true });
    if ('${change}' === 'missing-destination') await fs.rm(directory, { recursive: true });
    await fs.writeFile(path, JSON.stringify(pending));
    assert.deepEqual(await load(), []);
    assert(!(await runtime.diagnostics()).some(d => d.code === 'load.recovered'));
    assert((await runtime.diagnostics()).some(d => d.severity === 'error'));
    assert.equal(runtime.getContextProvider('recovery'), undefined);
  `));

  it('keeps unknown runtime or worker ownership protected', () => run(`
    await v1(); const path = join(homeDir, '.afk', 'plugins', '.active-context.recovery.json');
    await fs.writeFile(path, '{}');
    await assert.rejects(manager.remove('context.recovery'), /unknown|reference/);
    assert.deepEqual(await load(), []);
    assert.equal((await readInstalledPlugin(directory)).version, '1.0.0');
  `));

  it('recovers a pending upgrade after the installing process has exited', () => run(`
    await v1(); await write('2.0.0', 'factory');
    child('const {PluginManager}=await import(' + JSON.stringify(new URL('manager.js',base).href) + '); await new PluginManager({homeDir:' + JSON.stringify(homeDir) + '}).install(' + JSON.stringify(source) + ');');
    assert.deepEqual(await load(), ['context.recovery']); assert.equal(await value(), '1.0.0');
  `));

  it('recovers an interrupted upgrade with a provably dead manager lock owner', () => run(`
    await v1(); await write('2.0.0', 'factory'); await manager.install(source);
    const lock = join(homeDir, '.afk', 'plugins', '.manager.lock');
    child('import {writeFileSync} from "node:fs"; writeFileSync(' + JSON.stringify(lock) + ', JSON.stringify({pid:process.pid,token:"dead-owner"}));');
    assert.deepEqual(await load(), ['context.recovery']); assert.equal(await value(), '1.0.0');
  `));

  it('recovers after a runtime process exits during v2 activation', () => run(`
    await v1(); await write('2.0.0', 'crash'); await manager.install(source);
    child('const {PluginRuntime}=await import(' + JSON.stringify(new URL('runtime.js',base).href) + '); const {loadInstalledPlugins}=await import(' + JSON.stringify(new URL('loader.js',base).href) + '); await loadInstalledPlugins(new PluginRuntime(),{homeDir:' + JSON.stringify(homeDir) + '});');
    globalThis.recoveryAllow = true;
    assert.deepEqual(await load(), ['context.recovery']); assert.equal(await value(), '1.0.0');
  `));

  it('refuses confirmation when plugin settings change during activation', () => run(`
    await v1(); await write('2.0.0', 'concurrent'); await manager.install(source);
    assert.deepEqual(await load(), []); assert.equal(runtime.getContextProvider('recovery'), undefined);
    assert.deepEqual(readPluginConfiguration(homeDir).plugins[0].config, {concurrent:true});
    assert((await runtime.diagnostics()).some(d => d.code === 'load.recovery-failed'));
  `));

  it('completes confirmed cleanup after a restart even if the backup was already removed', () => run(`
    await v1(); await write('2.0.0'); await manager.install(source);
    const {parent,path,pending} = await journal(); pending.phase = 'confirmed';
    await fs.writeFile(path, JSON.stringify(pending));
    await fs.rm(join(parent,pending.backup), {recursive:true});
    assert.deepEqual(await load(), ['context.recovery']); assert.equal(await value(), '2.0.0');
    assert.equal(await fs.stat(path).then(() => true, () => false), false);
  `));

  it('refuses recovery that would remove a newly required capability', () => run(`
    await v1(); await write('2.0.0', 'factory');
    const manifestPath = join(source, 'plugin.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath,'utf8'));
    manifest.provides.push('example.new'); await fs.writeFile(manifestPath,JSON.stringify(manifest));
    await manager.install(source);
    const dependent = join(root,'dependent'); await fs.mkdir(dependent);
    await fs.writeFile(join(dependent,'package.json'), '{"type":"module"}');
    await fs.writeFile(join(dependent,'index.mjs'), 'throw Error("static installation must not execute");');
    await fs.writeFile(join(dependent,'plugin.json'),JSON.stringify({id:'context.dependent',version:'1.0.0',apiVersion:1,trusted:true,provides:[],requires:['example.new'],entry:'index.mjs'}));
    await manager.install(dependent);
    runtime = new PluginRuntime();
    assert.deepEqual(await loadInstalledPlugins(runtime,{homeDir,entries:[readPluginConfiguration(homeDir).plugins[0]]}),[]);
    assert.equal((await readInstalledPlugin(directory)).version,'2.0.0');
    assert((await runtime.diagnostics()).some(d => d.code === 'load.recovery-failed' && d.message.includes('context.dependent')));
  `));

  it('confirms with the settings actually selected before activation', () => run(`
    await v1(); await write('2.0.0'); await manager.install(source);
    await manager.configure('context.recovery', {selected:'v2'});
    assert.deepEqual(await load(), ['context.recovery']); assert.equal(await value(),'2.0.0');
    assert.deepEqual(readPluginConfiguration(homeDir).plugins[0].config,{selected:'v2'});
  `));

  it('recovers when the pending version cannot satisfy activation dependencies', () => run(`
    await v1(); await write('2.0.0');
    for (const name of ['plugin.json','index.mjs']) {
      const path = join(source,name); const text = await fs.readFile(path,'utf8');
      await fs.writeFile(path,text.replace('"provides":["context.provider"]','"provides":["context.provider"],"requires":["missing.provider"]'));
    }
    await manager.install(source);
    assert.deepEqual(await load(),['context.recovery']); assert.equal(await value(),'1.0.0');
    assert((await runtime.diagnostics()).some(d => d.code === 'load.dependencies'));
  `));

  it('retains files written into the failed installation while restoring the previous directory', () => run(`
    await v1(); await fs.writeFile(join(directory,'user-data'),'v1 data');
    await write('2.0.0','activate'); await manager.install(source);
    await fs.writeFile(join(directory,'user-data'),'v2 data');
    await load(); assert.equal(await value(),'1.0.0');
    assert.equal(await fs.readFile(join(directory,'user-data'),'utf8'),'v1 data');
    const parent = join(homeDir,'.afk','plugins');
    const failed = (await fs.readdir(parent)).find(n => n.startsWith('.failed-'));
    assert(failed); assert.equal(await fs.readFile(join(parent,failed,'user-data'),'utf8'),'v2 data');
  `));

  it('retains installation data on confirmation and removal', () => run(`
    await v1(); await fs.writeFile(join(directory,'user-data'),'old data');
    await write('2.0.0'); await manager.install(source); await load(); await runtime.dispose();
    const parent=join(homeDir,'.afk','plugins');
    const retired=(await fs.readdir(parent)).find(n=>n.startsWith('.retired-'));
    assert(retired); assert.equal(await fs.readFile(join(parent,retired,'user-data'),'utf8'),'old data');
    await fs.writeFile(join(directory,'user-data'),'current data'); await manager.remove('context.recovery');
    const removed=(await fs.readdir(parent)).find(n=>n.startsWith('.removed-'));
    assert(removed); assert.equal(await fs.readFile(join(parent,removed,'user-data'),'utf8'),'current data');
  `));

  it.each(['loader', 'dispose-then-loader'])('retains failed managed ownership until the same runtime confirms cleanup and safely restores v1 (%s)', retry => run(resourcePlugin + `
    await resourceV1();await writeResource('2.0.0',true);const record=await manager.install(source);
    assert.deepEqual(await load(),[]);
    assert(fstatSync(globalThis.cleanupState.fd).isFile());
    const parent=join(homeDir,'.afk','plugins'),active=join(parent,'.active-context.recovery.json');
    const lease=await fs.readFile(active,'utf8');const journalPath=join(parent,'.pending-context.recovery.json');
    assert.equal((await readInstalledPlugin(directory)).version,'2.0.0');assert(await fs.stat(journalPath));
    assert.equal(runtime.getPlugin('context.recovery'),undefined);assert.equal(runtime.getContextProvider('recovery'),undefined);
    assert.deepEqual(globalThis.cleanupState.calls['2.0.0'],{resource:1,independent:1});
    assert(!(await runtime.diagnostics()).some(d=>d.code==='load.recovered'));
    assert((await runtime.diagnostics()).some(d=>d.code==='activation.failed'&&d.message==='V2_ACTIVATION_ORIGINAL'&&d.details.rollbackErrors.includes('RESOURCE_CLEANUP_UNCONFIRMED')));
    await assert.rejects(manager.remove('context.recovery'),/active|reference/);
    await assert.rejects(manager.install(source),/active|reference/);
    await assert.rejects(manager.restoreActivation('context.recovery',record),/active|reference/);
    await assert.rejects(runtime.load({manifest:record.manifest,activate(){throw Error('must not activate');}}),/cleanup.*pending/);
    assert.deepEqual(await loadInstalledPlugins(runtime,{homeDir}),[]);
    assert.equal(await fs.readFile(active,'utf8'),lease);assert(await fs.stat(journalPath));
    assert.deepEqual(globalThis.cleanupState.calls['2.0.0'],{resource:2,independent:1});
    globalThis.cleanupState.allow=true;
    if ('${retry}' === 'dispose-then-loader') await runtime.dispose('context.recovery');
    assert.deepEqual(await loadInstalledPlugins(runtime,{homeDir}),['context.recovery']);assert.equal(await value(),'1.0.0');
    assert.deepEqual(globalThis.cleanupState.calls['2.0.0'],{resource:3,independent:1});
    assert.equal((await readInstalledPlugin(directory)).version,'1.0.0');
    assert.equal(await fs.stat(journalPath).then(()=>true,()=>false),false);
    await runtime.dispose();await manager.remove('context.recovery');assert.equal(globalThis.cleanupState.fd,undefined);
  `));

  it('retains managed ownership after normal disposal failure and retries without repeating destructive cleanup', () => run(resourcePlugin + `
    await resourceV1();await writeResource('2.0.0');await manager.install(source);await load();assert.equal(await value(),'2.0.0');
    await assert.rejects(runtime.dispose('context.recovery'),/failed to dispose/);
    assert(fstatSync(globalThis.cleanupState.fd).isFile());assert.equal(runtime.getContextProvider('recovery'),undefined);
    const active=join(homeDir,'.afk','plugins','.active-context.recovery.json');const lease=await fs.readFile(active,'utf8');
    await assert.rejects(manager.remove('context.recovery'),/active|reference/);
    await assert.rejects(manager.install(source),/active|reference/);
    await assert.rejects(runtime.dispose('context.recovery'),/failed to dispose/);
    assert.equal(await fs.readFile(active,'utf8'),lease);
    assert.deepEqual(globalThis.cleanupState.calls['2.0.0'],{resource:2,independent:1});
    globalThis.cleanupState.allow=true;await runtime.dispose('context.recovery');
    assert.equal(globalThis.cleanupState.fd,undefined);assert.deepEqual(globalThis.cleanupState.calls['2.0.0'],{resource:3,independent:1});
    await manager.remove('context.recovery');
  `));
});
