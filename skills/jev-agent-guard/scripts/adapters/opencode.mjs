#!/usr/bin/env node
import fs from 'node:fs';
import { askJev, choice, noul, score } from '../jev-client.mjs';

function safeParseJson(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function normalizePayload(payload) {
  const obj = payload && typeof payload === 'object' ? payload : {};
  const tool = obj.tool || obj.tool_name || obj.name || 'unknown';
  const command = obj.command || obj.args || obj.raw_command || '';
  const pathValue = obj.path || obj.file_path || obj.file || obj.target || '';
  return { tool, command, pathValue, raw: obj };
}

function classifyAction(payload) {
  const { tool, command, pathValue } = normalizePayload(payload);
  const text = `${tool} ${command} ${pathValue}`.toLowerCase();

  if (/git reset --hard|git clean -fd|rm -rf|chmod 777|docker rm|kubectl delete|drop database|sudo rm|: > \/dev\//i.test(text)) return 'deny';
  if /(secret|token|api[_-]?key|password|aws|gcp|azure|ssh key|\.pem|\.env|\.npmrc)/i.test(text)) return 'confirm';
  if /curl|wget|fetch\(|http[s]?:\/\//i.test(text)) return 'confirm';
  if (tool === 'read' || tool === 'cat' || tool === 'ls' || tool === 'glob') return 'allow';
  if (tool === 'edit' || tool === 'write' || tool === 'apply_patch' || tool === 'patch') return 'allow';
  return 'ambiguous';
}

async function decide(payload) {
  const current = normalizePayload(payload);
  const action = classifyAction(payload);

  if (action === 'deny') {
    return { decision: 'deny', action: 'block', dimension: 'safety', reason: 'Local policy blocked destructive or broad workspace mutation.', host: 'codex', tool: current.tool, command: current.command };
  }

  if (action === 'confirm') {
    return { decision: 'confirm', action: 'request_user_approval', dimension: 'permissions', reason: 'This action touches credentials, secrets, or network behavior and requires approval.', host: 'codex', tool: current.tool, command: current.command };
  }

  if (action === 'allow') {
    return { decision: 'allow', action: 'continue', dimension: 'local-policy', reason: 'This action matches the safe allowlist.', host: 'codex', tool: current.tool, command: current.command };
  }

  const state = {
    tool: current.tool,
    command: current.command,
    path: current.pathValue,
    repo: payload.repo || payload.repository || '',
  };

  const response = await askJev({
    state,
    questions: {
      risk: noul('Is this action destructive, secret-related, or dangerous to the repository?'),
      route: choice('What is the best handling?', {
        safe: 'This is a normal local workflow step.',
        review: 'This needs explicit approval before continuing.',
        block: 'This should be denied now.',
      }),
      severity: score('How risky is this action?', ['safe', 'review', 'dangerous']),
    },
  });

  const risk = response.answers.risk.noul ?? 0;
  const route = response.answers.route.choice ?? 'safe';
  const severity = response.answers.severity.score ?? 'safe';

  if (route === 'block' || risk >= 0.8 || severity === 'dangerous') {
    return { decision: 'deny', action: 'block', dimension: 'jev-risk', reason: `Jev rejected this action (risk=${risk}, route=${route}, severity=${severity}).`, host: 'codex', tool: current.tool, command: current.command };
  }

  if (route === 'review' || severity === 'review') {
    return { decision: 'confirm', action: 'request_user_approval', dimension: 'jev-review', reason: `Jev flagged this action for review (risk=${risk}, route=${route}, severity=${severity}).`, host: 'codex', tool: current.tool, command: current.command };
  }

  return { decision: 'allow', action: 'continue', dimension: 'jev-allow', reason: `Jev allowed this action (risk=${risk}, route=${route}, severity=${severity}).`, host: 'codex', tool: current.tool, command: current.command };
}

async function main() {
  const raw = fs.readFileSync(0, 'utf8');
  const payload = safeParseJson(raw);
  const result = await decide(payload);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.decision === 'allow' ? 0 : 2;
}

main().catch(error => {
  process.stderr.write(`${error.code ?? 'jev_error'}: ${error.message}\n`);
  process.exit(3);
});
