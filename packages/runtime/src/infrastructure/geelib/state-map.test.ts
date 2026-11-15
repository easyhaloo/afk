import { describe, expect, it } from 'vitest';
import { afkStateToNative, nativeToAfkState, NATIVE_STATE_NAMES } from './state-map.js';

describe('geelib native state mapping', () => {
  it('maps every AFK lifecycle state onto a verified reachable native state', () => {
    expect(afkStateToNative('ready')).toBe('新建');
    expect(afkStateToNative('in_progress')).toBe('修复中');
    expect(afkStateToNative('verification')).toBe('已修复');
    expect(afkStateToNative('merge_ready')).toBe('已验证');
    // `关闭` is unreachable through the API from every state probed, so done
    // collapses onto 已验证 and the merge confirmation travels as a comment.
    expect(afkStateToNative('done')).toBe('已验证');
    expect(afkStateToNative('blocked')).toBe('延期');
    expect(afkStateToNative('rework')).toBe('重新打开');
  });

  it('maps every native status name back onto an AFK state', () => {
    expect(nativeToAfkState('新建')).toBe('ready');
    expect(nativeToAfkState('修复中')).toBe('in_progress');
    expect(nativeToAfkState('已修复')).toBe('verification');
    expect(nativeToAfkState('已验证')).toBe('merge_ready');
    expect(nativeToAfkState('关闭')).toBe('done');
    expect(nativeToAfkState('重新打开')).toBe('rework');
    expect(nativeToAfkState('延期')).toBe('blocked');
    expect(nativeToAfkState('已拒绝')).toBe('blocked');
    expect(nativeToAfkState('未知状态')).toBeUndefined();
  });

  it('exposes the native names a setup must pre-provision knowledge of', () => {
    expect(NATIVE_STATE_NAMES).toContain('新建');
    expect(NATIVE_STATE_NAMES).toContain('修复中');
    expect(NATIVE_STATE_NAMES).toContain('已修复');
    expect(NATIVE_STATE_NAMES).toContain('已验证');
    expect(NATIVE_STATE_NAMES).toContain('延期');
    expect(NATIVE_STATE_NAMES).toContain('重新打开');
  });
});
