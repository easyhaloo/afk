import { closeSync, fstatSync, mkdtempSync, openSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PluginRuntime, type Plugin } from './runtime.js';

describe('Runtime cleanup confirmation', () => {
  it.each(['dispose', 'rollback'] as const)('keeps the next same-ID batch cleanup distinct from a settling %s', async firstBoundary => {
    const directory = mkdtempSync(join(tmpdir(), 'runtime-incarnation-'));
    const runtime = new PluginRuntime();
    const manifest: Plugin['manifest'] = { id: 'test.incarnation', version: '1.0.0', apiVersion: 1, trusted: true, provides: [] };
    const firstError = new Error('first activation failed');
    const secondError = new Error('second activation failed');
    const cleanupError = new Error('second resource still owned');
    const firstDispose = vi.fn(), firstConfirm = vi.fn(), secondConfirm = vi.fn();
    const independentDispose = vi.fn();
    let fd: number | undefined;
    let cleanupAllowed = false;
    let attempts = 0;
    let next!: Promise<unknown>;
    const second: Plugin = { manifest: { ...manifest, version: '2.0.0' }, activate(context) {
      fd = openSync(join(directory, 'resource'), 'wx');
      context.onDispose(independentDispose);
      context.onDispose(() => {
        attempts++;
        if (!cleanupAllowed) throw cleanupError;
        closeSync(fd!); fd = undefined;
      });
      throw secondError;
    } };
    const first: Plugin = { manifest, activate(context) {
      context.onDispose(firstDispose);
      if (firstBoundary === 'rollback') throw firstError;
    } };
    try {
      const loading = runtime.load(first, () => {
        firstConfirm();
        queueMicrotask(() => queueMicrotask(() => {
          next = runtime.load(second, secondConfirm).then(() => undefined, error => error);
        }));
      });
      if (firstBoundary === 'rollback') await expect(loading).rejects.toBe(firstError);
      else { await loading; await runtime.dispose(manifest.id); }
      const error = await next;
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([secondError, cleanupError]);
      expect(attempts).toBe(1);
      expect(fstatSync(fd!).isFile()).toBe(true);
      expect(runtime.hasPendingCleanup(manifest.id)).toBe(true);
      expect(runtime.getPlugin(manifest.id)).toBeUndefined();
      await expect(runtime.load(second)).rejects.toThrow(/cleanup.*pending/);
      expect(firstDispose).toHaveBeenCalledTimes(1);
      expect(firstConfirm).toHaveBeenCalledTimes(1);
      expect(independentDispose).toHaveBeenCalledTimes(1);
      expect(secondConfirm).not.toHaveBeenCalled();
      cleanupAllowed = true;
      await Promise.all([runtime.dispose(manifest.id), runtime.dispose(manifest.id)]);
      expect(attempts).toBe(2);
      expect(fd).toBeUndefined();
      expect(independentDispose).toHaveBeenCalledTimes(1);
      expect(secondConfirm).toHaveBeenCalledTimes(1);
      expect(runtime.hasPendingCleanup(manifest.id)).toBe(false);
      await runtime.load({ manifest, activate() {} });
      await runtime.dispose(manifest.id);
      expect(firstDispose).toHaveBeenCalledTimes(1);
      expect(secondConfirm).toHaveBeenCalledTimes(1);
    } finally {
      cleanupAllowed = true;
      await next?.catch(() => undefined);
      await runtime.dispose().catch(() => undefined);
      if (fd !== undefined) closeSync(fd);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([true, false])('retains failed cleanup and retries only failed callbacks (activation failure: %s)', async activationFails => {
    const directory = mkdtempSync(join(tmpdir(), 'runtime-cleanup-'));
    const path = join(directory, 'exclusive');
    const runtime = new PluginRuntime();
    const original = new Error('activation failed');
    const cleanupError = new Error('resource still open');
    let fd: number | undefined;
    let allowCleanup = false;
    let cleanupCalls = 0;
    let publications = 0;
    const independent = vi.fn();
    const confirmed = vi.fn();
    const plugin: Plugin = {
      manifest: { id: 'test.cleanup', version: '1.0.0', apiVersion: 1, trusted: true, provides: ['context.provider', 'workflow.action'] },
      activate(context) {
        fd = openSync(path, 'wx');
        context.onDispose(independent);
        context.onDispose(() => {
          cleanupCalls++;
          if (!allowCleanup) throw cleanupError;
          closeSync(fd!); unlinkSync(path); fd = undefined;
        });
        context.registerContextProvider('cleanup', { id: 'cleanup', capabilities: { search: true, 'read-only': true, summarize: false }, gather: async () => [] });
        context.registerSystemAction('cleanup.publish', () => { publications++; });
        if (activationFails) throw original;
      },
    };
    try {
      if (activationFails) {
        const error = await runtime.load(plugin, confirmed).catch(error => error);
        expect(error).toBeInstanceOf(AggregateError);
        expect(error.errors).toEqual([original, cleanupError]);
      } else {
        await runtime.load(plugin, confirmed);
        await expect(runtime.dispose(plugin.manifest.id)).rejects.toThrow('failed to dispose');
      }
      expect(fstatSync(fd!).isFile()).toBe(true);
      expect(runtime.getPlugin(plugin.manifest.id)).toBeUndefined();
      expect(runtime.getContextProvider('cleanup')).toBeUndefined();
      expect(runtime.listCapabilities()).toEqual([]);
      await expect(runtime.dispatchSystemAction('cleanup.publish', {})).rejects.toThrow('unknown system action');
      expect(publications).toBe(0);
      expect(independent).toHaveBeenCalledTimes(1);
      expect(confirmed).not.toHaveBeenCalled();
      await expect(runtime.load(plugin, confirmed)).rejects.toThrow(/cleanup.*pending/);
      expect(cleanupCalls).toBe(1);
      allowCleanup = true;
      await runtime.dispose(plugin.manifest.id);
      expect(fd).toBeUndefined();
      expect(cleanupCalls).toBe(2);
      expect(independent).toHaveBeenCalledTimes(1);
      expect(confirmed).toHaveBeenCalledTimes(1);
      await runtime.dispose();
      expect(confirmed).toHaveBeenCalledTimes(1);
    } finally {
      allowCleanup = true;
      await runtime.dispose().catch(() => undefined);
      if (fd !== undefined) closeSync(fd);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('continues other plugin cleanup and retries a failed confirmation without repeating disposers', async () => {
    const runtime = new PluginRuntime();
    const dispose = vi.fn();
    const other = vi.fn();
    const confirmationError = new Error('lease release unconfirmed');
    let allow = false;
    const confirmed = vi.fn(() => { if (!allow) throw confirmationError; });
    const plugin: Plugin = { manifest: { id: 'test.confirm', version: '1.0.0', apiVersion: 1, trusted: true, provides: [] }, activate(context) { context.onDispose(dispose); } };
    await runtime.load({ ...plugin, manifest: { ...plugin.manifest, id: 'test.other' }, activate(context) { context.onDispose(other); } });
    await runtime.load(plugin, confirmed);
    await expect(runtime.dispose()).rejects.toMatchObject({ errors: [confirmationError] });
    expect(other).toHaveBeenCalledTimes(1);
    expect(runtime.getPlugin('test.confirm')).toBeUndefined();
    await expect(runtime.load(plugin)).rejects.toThrow(/cleanup.*pending/);
    allow = true;
    await runtime.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
    expect(confirmed).toHaveBeenCalledTimes(2);
    await runtime.load(plugin);
    await runtime.dispose();
  });

  it('deduplicates concurrent cleanup attempts and keeps registrations unavailable throughout', async () => {
    const runtime = new PluginRuntime();
    let finish!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const cleanup = vi.fn(async () => { started(); await gate; });
    const confirmed = vi.fn();
    const plugin: Plugin = { manifest: { id: 'test.pending', version: '1.0.0', apiVersion: 1, trusted: true, provides: [] }, activate(context) { context.onDispose(cleanup); } };
    await runtime.load(plugin, confirmed);
    const first = runtime.dispose('test.pending');
    await entered;
    expect(runtime.getPlugin('test.pending')).toBeUndefined();
    await expect(runtime.load(plugin)).rejects.toThrow(/cleanup.*pending/);
    const second = runtime.dispose('test.pending');
    expect(confirmed).not.toHaveBeenCalled();
    finish();
    await Promise.all([first, second]);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(confirmed).toHaveBeenCalledTimes(1);
  });
});

function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

function dependencyFixture(mode = '') {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-dependency-'));
  const runtime = new PluginRuntime();
  const activation = gate(), activationStarted = gate(), cleanup = gate(), cleanupStarted = gate();
  const confirmation = gate(), confirmationStarted = gate(), parentCleanup = gate(), parentCleanupStarted = gate();
  let parentFd: number | undefined, childFd: number | undefined;
  let allowCleanup = mode !== 'activation-failed', allowConfirmation = mode !== 'confirmation-failed';
  let holdParentCleanup = false, childDisposals = 0;
  const parent: Plugin = {
    manifest: { id: 'test.parent', version: '1.0.0', apiVersion: 1, trusted: true, provides: ['spec.parent'] },
    activate(context) {
      const fd = parentFd = openSync(join(directory, 'parent'), 'wx');
      context.registerCapability('spec.parent', 'parent', { acknowledge() { writeSync(fd, 'child released'); } });
      context.onDispose(async () => {
        if (holdParentCleanup) { parentCleanupStarted.release(); await parentCleanup.promise; }
        closeSync(fd); unlinkSync(join(directory, 'parent')); parentFd = undefined;
      });
    },
  };
  const child: Plugin = {
    manifest: { id: 'test.child', version: '1.0.0', apiVersion: 1, trusted: true, provides: ['spec.child'], requires: ['spec.parent'] },
    async activate(context) {
      const provider = context.getProvider<{ acknowledge(): void }>('spec.parent', 'parent')!;
      const fd = childFd = openSync(join(directory, 'child'), 'wx');
      context.registerCapability('spec.child', 'child', {});
      context.onDispose(async () => {
        childDisposals++;
        if (mode === 'cleaning') { cleanupStarted.release(); await cleanup.promise; }
        if (!allowCleanup) throw new Error('CHILD_CLEANUP_UNCONFIRMED');
        provider.acknowledge(); closeSync(fd); unlinkSync(join(directory, 'child')); childFd = undefined;
      });
      if (mode === 'activating') { activationStarted.release(); await activation.promise; }
      if (mode === 'activation-failed') throw new Error('CHILD_ACTIVATION_FAILED');
    },
  };
  const confirm = async () => {
    if (mode === 'confirmation-pending') { confirmationStarted.release(); await confirmation.promise; }
    if (!allowConfirmation) throw new Error('CHILD_CONFIRMATION_UNCONFIRMED');
  };
  return {
    runtime, parent, child, confirm, activation, activationStarted, cleanup, cleanupStarted, confirmation, confirmationStarted, parentCleanup, parentCleanupStarted,
    get parentFd() { return parentFd; }, get childFd() { return childFd; }, get childDisposals() { return childDisposals; },
    allow() { allowCleanup = true; allowConfirmation = true; activation.release(); cleanup.release(); confirmation.release(); parentCleanup.release(); },
    failCleanup() { allowCleanup = false; }, holdParent() { holdParentCleanup = true; },
    async finish() {
      this.allow();
      await runtime.dispose('test.child').catch(() => undefined);
      await runtime.dispose('test.parent').catch(() => undefined);
      if (childFd !== undefined) closeSync(childFd);
      if (parentFd !== undefined) closeSync(parentFd);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe('Runtime dependency lifetime reservations', () => {
  it.each(['activation-failed', 'normal-disposal-failed', 'cleaning', 'confirmation-pending', 'confirmation-failed', 'activating'])('keeps the actual provider alive while its child is %s', async mode => {
    const fixture = dependencyFixture(mode);
    const { runtime, parent, child } = fixture;
    let loading: Promise<void> | undefined, disposing: Promise<void> | undefined;
    try {
      await runtime.load(parent);
      if (mode === 'activation-failed') await expect(runtime.load(child, fixture.confirm)).rejects.toThrow('CHILD_ACTIVATION_FAILED');
      else if (mode === 'activating') {
        loading = runtime.load(child, fixture.confirm);
        await fixture.activationStarted.promise;
        await expect(runtime.load({ ...child, activate() {} })).rejects.toThrow(/already loaded|activating/);
        await expect(runtime.dispose('test.child')).rejects.toThrow(/activating/);
      } else {
        await runtime.load(child, fixture.confirm);
        await expect(runtime.dispose('test.parent')).rejects.toThrow(/required.*test.child/);
        if (mode === 'normal-disposal-failed') fixture.failCleanup();
        disposing = runtime.dispose('test.child');
        if (mode === 'cleaning') await fixture.cleanupStarted.promise;
        else if (mode === 'confirmation-pending') await fixture.confirmationStarted.promise;
        else { await expect(disposing).rejects.toThrow('failed to dispose'); disposing = undefined; }
      }
      await expect(runtime.dispose('test.parent')).rejects.toThrow(/required.*test.child/);
      expect(fstatSync(fixture.parentFd!).isFile()).toBe(true);
      expect(runtime.getPlugin('test.parent')).toBe(parent);
      fixture.allow();
      await loading;
      await disposing;
      await runtime.dispose('test.child');
      expect(fixture.childFd).toBeUndefined();
      await runtime.dispose('test.parent');
      expect(fixture.parentFd).toBeUndefined();
      if (mode === 'confirmation-failed') expect(fixture.childDisposals).toBe(1);
    } finally {
      fixture.allow();
      await loading?.catch(() => undefined);
      await disposing?.catch(() => undefined);
      await fixture.finish();
    }
  });

  it.each(['before-child', 'after-child'])('does not substitute a different provider for the object held by the child (%s)', async order => {
    const fixture = dependencyFixture();
    const { runtime } = fixture;
    const alternative: Plugin = { manifest: { ...fixture.parent.manifest, id: 'test.alternative' }, activate(context) { context.registerCapability('spec.parent', 'alternative', {}); } };
    try {
      await runtime.load(fixture.parent);
      if (order === 'before-child') await runtime.load(alternative);
      await runtime.load(fixture.child);
      if (order === 'after-child') await runtime.load(alternative);
      await expect(runtime.dispose('test.parent')).rejects.toThrow(/required.*test.child/);
      expect(fstatSync(fixture.parentFd!).isFile()).toBe(true);
      await runtime.dispose('test.child');
      await runtime.dispose('test.parent');
      await runtime.dispose('test.alternative');
    } finally { await fixture.finish(); }
  });

  it('keeps dependencies alive on dispose-all failure while continuing independent cleanup', async () => {
    const fixture = dependencyFixture();
    const { runtime } = fixture;
    const independent = vi.fn();
    try {
      await runtime.load(fixture.parent); await runtime.load(fixture.child); fixture.failCleanup();
      await runtime.load({ manifest: { ...fixture.parent.manifest, id: 'test.independent', provides: [] }, activate(context) { context.onDispose(independent); } });
      const error = await runtime.dispose().catch(error => error);
      expect(error.errors.map((entry: Error) => entry.message)).toEqual(expect.arrayContaining(['CHILD_CLEANUP_UNCONFIRMED', expect.stringMatching(/required.*test.child/)]));
      expect(fstatSync(fixture.parentFd!).isFile()).toBe(true);
      expect(fstatSync(fixture.childFd!).isFile()).toBe(true);
      expect(independent).toHaveBeenCalledTimes(1);
      fixture.allow(); await runtime.dispose();
      expect(fixture.parentFd).toBeUndefined(); expect(fixture.childFd).toBeUndefined();
      expect(independent).toHaveBeenCalledTimes(1);
    } finally { await fixture.finish(); }
  });

  it('refuses admission once the provider has started cleaning', async () => {
    const fixture = dependencyFixture();
    const { runtime } = fixture;
    let disposing: Promise<void> | undefined;
    try {
      await runtime.load(fixture.parent); fixture.holdParent();
      disposing = runtime.dispose('test.parent'); await fixture.parentCleanupStarted.promise;
      await expect(runtime.load(fixture.child)).rejects.toThrow(/requires missing/);
      expect(fixture.childFd).toBeUndefined();
      expect(fstatSync(fixture.parentFd!).isFile()).toBe(true);
      fixture.allow(); await disposing;
    } finally { fixture.allow(); await disposing?.catch(() => undefined); await fixture.finish(); }
  });

  it('reserves a named provider acquired after an activation await and drains in dependency order', async () => {
    const fixture = dependencyFixture();
    const { runtime } = fixture;
    const entered = gate(), resume = gate();
    const acknowledged = vi.fn(), alternativeDisposed = vi.fn();
    const alternative: Plugin = {
      manifest: { ...fixture.parent.manifest, id: 'test.late' },
      activate(context) { context.registerCapability('spec.parent', 'late', { acknowledge: acknowledged }); context.onDispose(alternativeDisposed); },
    };
    let loading: Promise<void> | undefined;
    try {
      await runtime.load(fixture.parent);
      loading = runtime.load({ ...fixture.child, async activate(context) {
        entered.release(); await resume.promise;
        const provider = context.getProvider<{ acknowledge(): void }>('spec.parent', 'late')!;
        context.onDispose(() => { expect(alternativeDisposed).not.toHaveBeenCalled(); provider.acknowledge(); });
      } });
      await entered.promise; await runtime.load(alternative); resume.release(); await loading;
      await expect(runtime.dispose('test.late')).rejects.toThrow(/required.*test.child/);
      await runtime.dispose();
      expect(acknowledged).toHaveBeenCalledTimes(1);
      expect(alternativeDisposed).toHaveBeenCalledTimes(1);
      expect(runtime.listPlugins()).toEqual([]);
    } finally { resume.release(); await loading?.catch(() => undefined); await fixture.finish(); }
  });

  it.each(['id', 'capability'])('keeps explicit %s conflicts reserved until pending cleanup is confirmed', async conflict => {
    const fixture = dependencyFixture('activation-failed');
    const { runtime } = fixture;
    const activate = vi.fn();
    const contender: Plugin = {
      manifest: { id: 'test.contender', version: '1.0.0', apiVersion: 1, trusted: true, provides: [], conflicts: [conflict === 'id' ? 'test.child' : 'spec.child'] }, activate,
    };
    try {
      await runtime.load(fixture.parent);
      await expect(runtime.load(fixture.child)).rejects.toThrow('CHILD_ACTIVATION_FAILED');
      await expect(runtime.load(contender)).rejects.toThrow('conflicts');
      expect(activate).not.toHaveBeenCalled();
      fixture.allow(); await runtime.dispose('test.child');
      await runtime.load(contender); expect(activate).toHaveBeenCalledTimes(1);
      await runtime.dispose();
    } finally { await fixture.finish(); }
  });
});
