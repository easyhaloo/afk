import { describe, expect, it } from 'vitest';
import { deriveStepCompletionKind, deriveStepPhase, isVerificationRole } from './step-behaviour.js';
import type { Step } from './types.js';

function step(overrides: Partial<Step> = {}): Step {
  return { id: 'step', role: 'implementer', prompt: 'p', ...overrides };
}

describe('step behaviour — the legacy derivation', () => {
  it('derives the implementation phase and the task protocol from an ordinary role', () => {
    // What the runner did before a template could declare a phase: an
    // implementation step speaks the plain task protocol.
    expect(deriveStepPhase(step({ role: 'implementer' }))).toBe('implementation');
    expect(deriveStepCompletionKind(step({ role: 'implementer' }))).toBe('task');
  });

  it('derives the verification phase and the AC protocol from a verification role', () => {
    // The acceptance-criteria step was the one whose role was 'verifier'.
    expect(deriveStepPhase(step({ role: 'verifier' }))).toBe('verification');
    expect(deriveStepCompletionKind(step({ role: 'verifier' }))).toBe('ac');
  });

  it('keeps a review step on the task protocol, as it was before the phase existed', () => {
    expect(deriveStepPhase(step({ role: 'reviewer' }))).toBe('implementation');
    expect(deriveStepCompletionKind(step({ role: 'reviewer' }))).toBe('task');
  });

  it('never derives the QA protocol', () => {
    // Only a declaration produces the QA protocol.
    expect(deriveStepCompletionKind(step({ role: 'qa' }))).toBe('task');
    expect(deriveStepCompletionKind(step({ role: 'qa-verifier' }))).toBe('ac');
  });

  it('recognizes a role that names verification in any spelling', () => {
    expect(isVerificationRole('verifier')).toBe(true);
    expect(isVerificationRole('ac-verifier')).toBe(true);
    expect(isVerificationRole('Verification-Agent')).toBe(true);
    expect(isVerificationRole('reviewer')).toBe(false);
    expect(isVerificationRole('implementer')).toBe(false);
    expect(isVerificationRole(undefined)).toBe(false);
  });
});

describe('step behaviour — an explicit declaration overrides the derivation', () => {
  it('lets a step declare the implementation phase even when its role names verification', () => {
    expect(deriveStepPhase(step({ role: 'verifier', phase: 'implementation' }))).toBe('implementation');
  });

  it('lets a step declare the verification phase even when its role does not', () => {
    expect(deriveStepPhase(step({ role: 'implementer', phase: 'verification' }))).toBe('verification');
  });

  it('lets a step declare the completion kind on its own', () => {
    expect(deriveStepCompletionKind(step({ role: 'implementer', completionKind: 'qa' }))).toBe('qa');
    expect(deriveStepCompletionKind(step({ role: 'verifier', completionKind: 'task' }))).toBe('task');
  });

  it('derives the completion kind from an explicitly declared phase', () => {
    expect(deriveStepCompletionKind(step({ role: 'implementer', phase: 'verification' }))).toBe('ac');
    expect(deriveStepCompletionKind(step({ role: 'verifier', phase: 'implementation' }))).toBe('task');
  });

  it('keeps the declared kind when the phase says something else', () => {
    expect(deriveStepCompletionKind(step({ phase: 'implementation', completionKind: 'ac' }))).toBe('ac');
  });

  it('puts a step that declares the AC protocol in the verification phase', () => {
    // The AC protocol verifies, so a step that speaks it verifies — whatever
    // its role says.
    expect(deriveStepPhase(step({ role: 'implementer', completionKind: 'ac' }))).toBe('verification');
  });
});
