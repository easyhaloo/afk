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

function classifyAction(payload) {
  const tool = payload.tool_name || payload.tool || payload.toolName || 'unknown';
  const command = payload.command || payload.arguments?.command || payload.cmd || '';
  const filePath = payload.file_path || payload.path || payload.file || '';
  const joined = `${tool} ${command} ${filePath}`.toLowerCase();

  const destructive = /(git reset --hard|git clean -fd|git checkout --|rm -rf|docker rm|kubectl delete|drop database|chmod 777|curl .*\| sh|bash -c .*curl)/i.test(joined);
  const credential = /(secret|token|api[_-]?key|password|aws|gcp|azure|ssh key|\.pem|\.env|\.npmrc|\.git/config)/i.test(joined);
  const network = /curl|wget|fetch\(|http[s]?:\/\//i.test(joined);
  const broad = /rm -rf|find \/|mv .*\.|cp -r|git checkout .*-- .+\*|apply_patch|sed -i/ i.test(joined);

  if (destructive || broad) return 'deny';
  if (credential) return 'confirm';
  if (network) return 'confirm';
  if (tool === 'Read' || tool === 'read' || tool.includes('read')) return 'allow';
  if (tool === 'Edit' || tool === 'edit' || tool.includes('write')) return 'allow';
  return 'ambiguous';
}

function buildState(payload) {
  return {
    tool: payload.tool_name || payload.tool || 'unknown',
    command: payload.command || payload.arguments?.command || '',
    file_path: payload.file_path || payload.path || '',
    intent: payload.intent || 'agent action',
    repo: payload.repo || payload.repository || '',
    cwd: payload.cwd || process.cwd(),
  };
}

async function decide(payload) {
  const action = classifyAction(payload);
  const basic = {
    decision: 'allow',
    action: 'continue',
    dimension: 'local-policy',
    reason: 'No local risk flags were found for this action.',
    host: 'claude-code',
    tool: payload.tool_name || payload.tool || 'unknown',
    command: payload.command || payload.arguments?.command || '',
  };

  if (action === 'deny') {
    return { ...basic, decision: 'deny', action: 'block', dimension: 'safety', reason: 'This action matches destructive or broad-rewrite patterns and is blocked by local policy.' };
  }

  if (action === 'confirm') {
    return { ...basic, decision: 'confirm', action: 'request_user_approval', dimension: 'credentials', reason: 'This action touches credentials, secrets, or external-network behavior and requires approval.' };
  }

  if (action === 'allow') {
    return basic;
  }

  const state = buildState(payload);
  const response = await askJev({
    state,
    questions: {
      risk: noul('Is this action destructive or credential sensitive?'),
      intent: choice('What is the user intent behind this tool call?', {
        safe_read: 'Read or inspect data in the workspace.',
        safe_edit: 'Modify code or docs in the active workspace.',
        risky_command: 'Run a shell command or external network action.',
        dangerous: 'Mutate git state, credentials, or infrastructure.',
      }),
      severity: score('How risky is this action?', ['safe', 'review', 'dangerous']),
    },
  });

  const risk = response.answers.risk.noul ?? 0;
  const intent = response.answers.intent.choice ?? 'safe_edit';
  const severity = response.answers.severity.score ?? 'safe';

  if (risk >= 0.75 || intent === 'dangerous' || severity === 'dangerous') {
    return {
      decision: 'deny',
      action: 'block',
      dimension: 'jev-risk',
      reason: `Jev classified this action as high risk (risk=${risk}, intent=${intent}, severity=${severity}).`,
      host: 'claude-code',
      tool: basic.tool,
      command: basic.command,
    };
  }

  if (severity === 'review' || intent === 'risky_command') {
    return {
      decision: 'confirm',
      action: 'request_user_approval',
      dimension: 'jev-review',
      reason: `Jev flagged this action for review (risk=${risk}, intent=${intent}, severity=${severity}).`,
      host: 'claude-code',
      tool: basic.tool,
      command: basic.command,
    };
  }

  return {
    decision: 'allow',
    action: 'continue',
    dimension: 'jev-allow',
    reason: `Jev judged the action acceptable (risk=${risk}, intent=${intent}, severity=${severity}).`,
    host: 'claude-code',
    tool: basic.tool,
    command: basic.command,
  };
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
