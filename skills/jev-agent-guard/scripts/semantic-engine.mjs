#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { askJev, choice, noul, score } from './jev-client.mjs';

const RULE_FILE = new URL('../rules/semantic.json', import.meta.url);

async function loadRules() {
  return JSON.parse(await fs.readFile(RULE_FILE, 'utf8'));
}

function buildQuestion(question) {
  if (question.type === 'noul') return noul(question.instructions);
  if (question.type === 'choice') return choice(question.instructions, question.criteria);
  if (question.type === 'score') return score(question.instructions, question.criteria);
  throw new Error(`Unsupported Jev question type: ${question.type}`);
}

function questionMap(rule) {
  return Object.fromEntries(Object.entries(rule.questions).map(([name, question]) => [name, buildQuestion(question)]));
}

function severityValue(answer) {
  const value = answer?.score;
  return typeof value === 'number' ? value : -1;
}

function semanticDecision(rule, answers) {
  if (rule.id === 'action-risk') {
    const risk = answers.dangerous?.noul ?? 0;
    const handling = answers.handling?.choice;
    const severity = severityValue(answers.severity);
    if (risk >= rule.thresholds.dangerous.deny || handling === 'deny' || severity >= rule.thresholds.severity.deny) {
      return { decision: 'deny', action: 'block', reason: 'Jev identified a dangerous or irreversible action.' };
    }
    if (risk >= rule.thresholds.dangerous.confirm || handling === 'confirm' || severity >= rule.thresholds.severity.confirm) {
      return { decision: 'confirm', action: 'request_user_approval', reason: 'Jev identified an action that requires human review.' };
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
    if (next === 'finish' && compliant >= rule.thresholds.compliant.finish) {
      return { decision: 'finish', action: 'finish', reason: 'Jev found the active Skill contract satisfied.' };
    }
    if (compliant < rule.thresholds.compliant.redirect || next !== 'continue') {
      return { decision: 'redirect', action: next, reason: 'Jev found that the active Skill contract still needs work.' };
    }
    return { decision: 'allow', action: 'continue', reason: 'Jev found the current work consistent with the active Skill.' };
  }

  throw new Error(`Unsupported semantic rule: ${rule.id}`);
}

export async function evaluateSemantic(ruleId, state, clientOptions) {
  const config = await loadRules();
  const rule = config.rules.find(item => item.id === ruleId);
  if (!rule) throw new Error(`Unknown semantic rule: ${ruleId}`);
  const response = await askJev({ state, questions: questionMap(rule), options: clientOptions });
  const result = semanticDecision(rule, response.answers);
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
