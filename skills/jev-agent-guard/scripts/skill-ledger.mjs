import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function ledgerFile(key, env) {
  if (!key.sessionId) return null;
  const home = env.HOME || os.homedir();
  const directory = path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'jev-agent-guard', 'sessions');
  const digest = crypto.createHash('sha256').update(JSON.stringify([key.host, key.sessionId, key.projectRoot])).digest('hex');
  return path.join(directory, `${digest}.json`);
}

export function loadLedger(key, env = process.env) {
  const file = ledgerFile(key, env);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Date.now() - ledger.updatedAt < 24 * 60 * 60 * 1000 ? ledger : null;
  } catch { return null; }
}

function save(key, ledger, env) {
  const file = ledgerFile(key, env);
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const staged = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(staged, JSON.stringify({ ...ledger, updatedAt: Date.now() }), { mode: 0o600 });
  fs.renameSync(staged, file);
}

export function recordSkill(key, contract, env = process.env) {
  save(key, { skill: {
    name: contract.name.slice(0, 80),
    steps: contract.steps.slice(0, 12),
    constraints: contract.constraints.slice(0, 12),
  }, evidence: [], actionCount: 0, stopBlockedAt: null }, env);
}

export function recordAction(key, action, env = process.env) {
  const ledger = loadLedger(key, env) ?? { skill: null, evidence: [], failureStreak: 0 };
  const previous = ledger.evidence.at(-1);
  ledger.failureStreak = !action.success && previous?.tool === action.tool && !previous.success
    ? (ledger.failureStreak ?? 1) + 1 : action.success ? 0 : 1;
  ledger.evidence = [...ledger.evidence, { tool: String(action.tool).slice(0, 80), success: Boolean(action.success) }].slice(-40);
  ledger.actionCount = (ledger.actionCount ?? 0) + 1;
  save(key, ledger, env);
  return ledger;
}

export function markStopBlocked(key, env = process.env) {
  const ledger = loadLedger(key, env);
  if (!ledger) return;
  ledger.stopBlockedAt = ledger.actionCount ?? 0;
  save(key, ledger, env);
}
