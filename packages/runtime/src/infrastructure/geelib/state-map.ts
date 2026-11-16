import type { BacklogState } from '../../domain/backlog/index.js';

/**
 * The native status names of the Geelib work-item types AFK drives.
 *
 * These are the names the platform's state machine knows, read live from
 * `Matter/getMatterStatus` on the reference instance. Transitions that were
 * verified against the live machine (the ones this mapping relies on):
 *
 * - 新建 → 修复中 → 已修复 → 已验证 (the main line)
 * - 修复中 → 延期 and 延期 → 修复中 (block and resume)
 * - 已验证 → 重新打开 → 修复中 (rework loop)
 * - 新建/延期 → 已拒绝, and everything resumes from 已拒绝
 *
 * `关闭` refused every transition probed (修复中/已验证/延期 → 关闭 all
 * return errno 5001), so it is reachable only through the platform UI. AFK
 * therefore never writes 关闭: `done` collapses onto 已验证 and the merge
 * confirmation travels as a comment — a platform limitation to raise with
 * the Geelib team.
 */
export const NATIVE_STATE_NAMES = ['新建', '修复中', '已修复', '已验证', '重新打开', '延期', '已拒绝', '关闭'] as const;

export type NativeStateName = typeof NATIVE_STATE_NAMES[number];

/**
 * AFK lifecycle position → the native state AFK writes.
 *
 * `done` and `merge_ready` intentionally collapse onto the same native
 * state: the platform has no state between "verified" and "closed", and
 * `closed` is not reachable through the API. The done confirmation is
 * carried by the reconciliation comment, not by the status field.
 */
const AFK_TO_NATIVE: Readonly<Record<BacklogState, NativeStateName>> = {
  ready: '新建',
  in_progress: '修复中',
  verification: '已修复',
  merge_ready: '已验证',
  done: '已验证',
  blocked: '延期',
  rework: '重新打开',
};

/** Native status name → AFK lifecycle position. */
const NATIVE_TO_AFK: Readonly<Record<NativeStateName, BacklogState>> = {
  新建: 'ready',
  修复中: 'in_progress',
  已修复: 'verification',
  已验证: 'merge_ready',
  关闭: 'done',
  重新打开: 'rework',
  延期: 'blocked',
  已拒绝: 'blocked',
};

export function afkStateToNative(state: BacklogState): NativeStateName {
  return AFK_TO_NATIVE[state];
}

export function nativeToAfkState(name: string): BacklogState | undefined {
  return NATIVE_TO_AFK[name as NativeStateName];
}
