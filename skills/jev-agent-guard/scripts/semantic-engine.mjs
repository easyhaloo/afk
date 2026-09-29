#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askJev, choice, noul, score } from './jev-client.mjs';

const LOG_DIR = path.join(os.homedir(), '.afk', 'jev-agent-guard');
const LOG_FILE = path.join(LOG_DIR, 'semantic-engine.jsonl');

const RULE_FILE = new URL('../rules/semantic.json', import.meta.url);

function appendLog(entry) {
  try {
    fsSync.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    fsSync.chmodSync(LOG_DIR, 0o700);
    const descriptor = fsSync.openSync(LOG_FILE, 'a', 0o600);
    try {
      fsSync.fchmodSync(descriptor, 0o600);
      fsSync.writeSync(descriptor, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
    } finally {
      fsSync.closeSync(descriptor);
    }
  } catch {
    // best effort only
  }
}

export function auditRecord(ruleId, result) {
  return { type: 'evaluate', ruleId, decision: result.decision };
}

async function loadRules() {
  return JSON.parse(await fs.readFile(RULE_FILE, 'utf8'));
}

function buildQuestion(question) {
  if (question.type === 'noul') return noul(question.instructions);
  if (question.type === 'choice') return choice(question.instructions, question.criteria);
  if (question.type === 'score') return score(question.instructions, question.criteria);
  throw new Error(`Unsupported Jev question type: ${question.type}`);
}

function questionsFor(rule, state) {
  if (rule.id !== 'skill-compliance') return rule.questions;
  const steps = Array.isArray(state?.skill?.steps) ? state.skill.steps.slice(0, 12) : [];
  return { ...rule.questions, missing_step: { ...rule.questions.missing_step,
    criteria: { ...rule.questions.missing_step.criteria,
      ...Object.fromEntries(steps.map((step, index) => [`step_${index + 1}`, String(step).slice(0, 160)])) },
  } };
}

function questionMap(questions) {
  return Object.fromEntries(Object.entries(questions).map(([name, question]) => [name, buildQuestion(question)]));
}

function validateAnswers(questions, answers) {
  if (!answers || typeof answers !== 'object') throw new Error('Malformed Jev answers');
  for (const [name, question] of Object.entries(questions)) {
    const answer = answers[name];
    const valid = question.type === 'noul'
      ? answer?.type === 'noul' && Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1
      : question.type === 'choice'
        ? answer?.type === 'choice' && Object.hasOwn(question.criteria, answer.choice)
        : answer?.type === 'score' && Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= question.criteria.length - 1;
    if (!valid) throw new Error(`Malformed Jev answer: ${name}`);
  }
}

function severityValue(answer) {
  const value = answer?.score;
  return typeof value === 'number' ? value : -1;
}

function semanticDecision(rule, answers, state) {
  if (rule.id === 'action-risk') {
    const risk = answers.dangerous?.noul ?? 0;
    const handling = answers.handling?.choice;
    const severity = severityValue(answers.severity);
    if (risk >= rule.thresholds.dangerous.deny || handling === 'deny' || severity >= rule.thresholds.severity.deny) {
      return { decision: 'deny', action: 'block', reason: 'Jev identified a dangerous or irreversible action.' };
    }
    if (risk >= rule.thresholds.dangerous.confirm || handling === 'confirm' || severity >= rule.thresholds.severity.confirm) {
      return { decision: 'warn', action: 'defer_to_host', reason: 'Jev identified a potentially sensitive action; native permissions still apply.' };
    }
    return { decision: 'allow', action: 'continue', reason: 'Jev identified a bounded action.' };
  }

  if (rule.id === 'trajectory-state') {
    const stuck = answers.stuck?.noul ?? 0;
    const next = answers.next_step?.choice ?? 'inspect_failure';
    if (stuck >= rule.thresholds.stuck.redirect || next === 'change_hypothesis' || next === 'ask_user') {
      return { decision: 'redirect', action: next === 'ask_user' ? 'ask_user' : 'change_hypothesis', reason: 'Jev identified insufficient progress on the current execution path.' };
    }
    if (next === 'finish') return { decision: 'finish', action: 'finish', reason: 'Jev found sufficient evidence to finish.' };
    return { decision: 'warn', action: next, reason: 'Jev selected a focused next step.' };
  }

  if (rule.id === 'context-retention') {
    const retain = answers.retain?.noul ?? 0;
    const role = answers.role?.choice ?? 'stale';
    if (role === 'requirement' || role === 'evidence' || retain >= rule.thresholds.retain.keep) {
      return { decision: 'keep', action: 'keep', reason: 'Jev identified context that remains useful.' };
    }
    if (retain >= rule.thresholds.retain.truncate || role === 'implementation') {
      return { decision: 'truncate', action: 'truncate', reason: 'Jev identified context that may be useful in reduced form.' };
    }
    return { decision: 'drop', action: 'drop', reason: 'Jev identified stale or irrelevant context.' };
  }

  if (rule.id === 'skill-compliance') {
    const compliant = answers.compliant?.noul ?? 0;
    const next = answers.next_step?.choice ?? 'return_to_missing_step';
    const selectedStep = answers.missing_step?.choice;
    const stepIndex = /^step_([1-9]\d*)$/.exec(selectedStep ?? '')?.[1];
    const missingStep = stepIndex ? state?.skill?.steps?.[Number(stepIndex) - 1] : undefined;
    if (next === 'finish' && compliant >= rule.thresholds.compliant.finish && !missingStep) {
      return { decision: 'finish', action: 'finish', reason: 'Jev found the active Skill contract satisfied.' };
    }
    if (missingStep && next !== 'finish') {
      return { decision: 'redirect', action: next, reason: 'A specific Skill step needs completion.',
        nextStep: `Complete Skill step: ${String(missingStep).slice(0, 160)}. Verify the outcome before finishing.` };
    }
    if (compliant < rule.thresholds.compliant.redirect || next !== 'continue') {
      const nextStep = {
        validate: 'Run the required validation and check its result before finishing.',
        inspect_diff: 'Inspect the final diff and changed files before finishing.',
        ask_user: 'Ask the user to clarify the missing requirement before proceeding.',
      }[next] ?? 'Review the Skill steps and validation results; continue only if a requirement is unmet.';
      return { decision: 'warn', action: next, reason: 'Jev could not identify an unfinished Skill step from bounded evidence.',
        nextStep };
    }
    return { decision: 'allow', action: 'continue', reason: 'Jev found the current work consistent with the active Skill.' };
  }

  throw new Error(`Unsupported semantic rule: ${rule.id}`);
}

export async function evaluateSemantic(ruleId, state, clientOptions, { ask = askJev, log = appendLog } = {}) {
  const config = await loadRules();
  const rule = config.rules.find(item => item.id === ruleId);
  if (!rule) throw new Error(`Unknown semantic rule: ${ruleId}`);
  const questions = questionsFor(rule, state);
  const response = await ask({ state, questions: questionMap(questions), options: clientOptions });
  validateAnswers(questions, response?.answers);
  const result = semanticDecision(rule, response.answers, state);
  log(auditRecord(ruleId, result));
  return { ...result, rule: rule.id, answers: response.answers };
}

export async function evaluateAllSemantic(state, clientOptions) {
  const config = await loadRules();
  const results = [];
  for (const rule of config.rules) results.push(await evaluateSemantic(rule.id, state, clientOptions));
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = JSON.parse(await fs.readFile(process.argv[2] ?? '/dev/stdin', 'utf8'));
  const ruleId = process.argv[3] ?? 'action-risk';
  console.log(JSON.stringify(await evaluateSemantic(ruleId, input, {}), null, 2));
}
