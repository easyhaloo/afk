#!/usr/bin/env node
import { evaluateSemantic } from '../semantic-engine.mjs';
import fs from 'node:fs';
import { decideChoice } from '../jev-client.mjs';
import { extractContract, findSkill, listSkillMetadata, recommendSkill, skillRoots } from '../skill-catalog.mjs';
import { loadLedger, markStopBlocked, recordAction, recordSkill } from '../skill-ledger.mjs';

const destructive = /\b(?:git\s+(?:reset\s+--hard|clean\s+-[a-z]*f|push\s+--force)|rm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r|sudo\b)\b|(?:curl|wget)\b[^|]*\|\s*(?:bash|sh)\b/i;
const secretAccess = /(?:^|[\s/])(?:\.env(?:\.[^\s/]*)?|\.ssh|\.aws|id_rsa|id_ed25519)(?:[\s/]|$)/i;
const network = /\b(?:curl|wget|git\s+(?:push|clone)|npm\s+(?:install|exec)|pnpm\s+(?:add|install|dlx)|pip\s+install)\b/i;
const safeCommand = /^(?:pwd|ls(?:\s+[^;&|]+)?|rg(?:\s+[^;&|]+)?|git\s+status(?:\s+[^;&|]+)?|git\s+diff(?:\s+[^;&|]+)?|cat\s+[^;&|]+)$/i;
const readTools = new Set(['Read', 'Glob', 'Grep', 'Skill']);

function actionOf(payload) {
  const input = payload.tool_input ?? payload.action ?? payload.input ?? {};
  return {
    tool: String(payload.tool_name ?? payload.tool ?? input.tool ?? 'unknown').slice(0, 80),
    command: typeof input.command === 'string' ? input.command : typeof payload.command === 'string' ? payload.command : '',
    localTarget: typeof input.file_path === 'string' ? input.file_path
      : typeof input.path === 'string' ? input.path : typeof payload.path === 'string' ? payload.path : '',
    kind: String(input.kind ?? payload.action_kind ?? 'unknown').slice(0, 80),
  };
}

function category(action) {
  if (destructive.test(action.command) || secretAccess.test(`${action.command} ${action.localTarget}`)) return 'deny';
  if (readTools.has(action.tool) || safeCommand.test(action.command.trim())) return 'allow';
  return network.test(action.command) ? 'network' : 'ambiguous';
}

function normalizedState(payload, host, event, action, risk, ledger) {
  const activeSkill = ledger?.skill ?? payload.activeSkill ?? payload.active_skill;
  return {
    version: 1,
    host,
    event_kind: event,
    session_id: typeof payload.session_id === 'string' ? payload.session_id.slice(0, 100) : undefined,
    action: { tool: action.tool, kind: action.kind, risk },
    skill: activeSkill && typeof activeSkill === 'object'
      ? { name: String(activeSkill.name ?? activeSkill.id ?? '').slice(0, 80),
        steps: Array.isArray(activeSkill.steps) ? activeSkill.steps.slice(0, 12) : [],
        constraints: Array.isArray(activeSkill.constraints) ? activeSkill.constraints.slice(0, 12) : [] }
      : undefined,
    evidence: ledger?.evidence?.slice(-40),
  };
}

function result(decision, reason, host, event, nextStep) {
  return { schema_version: 1, host, event, decision, reason, ...(nextStep ? { nextStep } : {}) };
}

function stopLedger(key, host, projectRoot, env) {
  const ledger = loadLedger(key, env);
  if (!ledger?.skill || ledger.skill.steps?.length) return ledger;
  const matched = findSkill(listSkillMetadata(skillRoots(host, projectRoot, env)), ledger.skill.name);
  if (!matched) return ledger;
  try {
    const contract = extractContract(fs.readFileSync(matched.file, 'utf8'));
    return { ...ledger, skill: contract };
  } catch { return ledger; }
}

export async function runAdapter({ host, event = 'before-action', payload = {}, evaluate = evaluateSemantic, env = process.env, catalog }) {
  const action = actionOf(payload);
  const risk = category(action);
  const projectRoot = String(payload.cwd ?? payload.project_root ?? process.cwd());
  const key = { host, sessionId: payload.session_id ?? payload.sessionID, projectRoot };
  if (event === 'resume-context') {
    const ledger = loadLedger(key, env);
    if (!ledger?.skill) return result('allow', 'No active Skill context to restore.', host, event);
    const failures = ledger.evidence.filter(item => !item.success).length;
    const nextStep = `Active Skill: ${ledger.skill.name}. Required steps: ${ledger.skill.steps.join('; ').slice(0, 800)}. Evidence: ${ledger.evidence.length} tool actions, ${failures} failures.`;
    return result('advise', 'Restoring compacted Skill state.', host, event, nextStep);
  }
  if (event === 'prompt') {
    const candidates = catalog ?? listSkillMetadata(skillRoots(host, projectRoot, env));
    const selected = await recommendSkill(String(payload.prompt ?? ''), candidates, async state => {
      const answer = await decideChoice({ state: { terms: state.terms },
        prompt: 'Which Skill name best matches the task terms?',
        options: Object.fromEntries(state.candidates.map(candidate => [candidate.name, 'Use this Skill for the task.'])),
        clientOptions: { timeout: 2500, retry: { maxRetries: 0 } },
      });
      return answer.choice;
    });
    return selected ? result('advise', 'Skill routing recommendation.', host, event, `Suggested Skill: ${selected}`)
      : result('allow', 'No relevant Skill was found.', host, event);
  }
  if (event === 'after-action') {
    const input = payload.tool_input ?? payload.action ?? {};
    const success = payload.outcome?.success ?? (payload.tool_response?.exit_code === undefined &&
      payload.tool_response?.exitCode === undefined ? !payload.tool_response?.is_error
        : (payload.tool_response.exit_code ?? payload.tool_response.exitCode) === 0);
    if (action.tool.toLowerCase() === 'skill' && success) {
      const name = input.skill ?? input.name;
      if (typeof name === 'string') {
        const matched = findSkill(listSkillMetadata(skillRoots(host, projectRoot, env)), name);
        const contract = matched ? extractContract(fs.readFileSync(matched.file, 'utf8')) : { name, steps: [], constraints: [] };
        recordSkill(key, contract, env);
      }
    } else {
      const ledger = recordAction(key, { tool: action.tool, success }, env);
      if (ledger?.failureStreak >= 3 && ledger.failureStreak % 3 === 0) {
        try {
          const semantic = await evaluate('trajectory-state', normalizedState(payload, host, event, action, risk, ledger),
            { timeout: 2500, retry: { maxRetries: 0 } });
          return result('advise', semantic.reason, host, event, semantic.action);
        } catch { return result('advise', 'Jev unavailable after repeated failures.', host, event); }
      }
    }
    return result('allow', 'Evidence checkpoint recorded.', host, event);
  }
  if (event === 'before-action') {
    if (risk === 'deny') return result('deny', 'Local policy blocks destructive or credential-related access.', host, event);
    if (risk === 'allow') return result('allow', 'Bounded local action; native permissions still apply.', host, event);
    if (risk !== 'network') return result('advise', 'Unclassified action; retain native permissions.', host, event);
  } else if (event === 'stop') {
    const ledger = loadLedger(key, env);
    if (!ledger?.skill && !payload.activeSkill && !payload.active_skill) return result('allow', 'No active Skill contract was observed.', host, event);
    if (payload.stop_hook_active || (ledger?.stopBlockedAt != null && ledger.stopBlockedAt === (ledger.actionCount ?? 0))) {
      return result('allow', 'Skill stop feedback was already delivered without new evidence.', host, event);
    }
  } else if (event !== 'stop') {
    return result('advise', 'No verifiable evidence for a semantic checkpoint.', host, event);
  }

  try {
    const rule = event === 'stop' ? 'skill-compliance' : 'action-risk';
    const ledger = event === 'stop' ? stopLedger(key, host, projectRoot, env) : null;
    const activeSkill = ledger?.skill ?? payload.activeSkill ?? payload.active_skill;
    if (event === 'stop' && !activeSkill?.steps?.length) {
      return result('advise', 'No structured Skill steps were found, so completion cannot be checked.', host, event,
        'Review the Skill instructions and validation before finishing.');
    }
    const semantic = await evaluate(rule, normalizedState(payload, host, event, action, risk, ledger),
      { timeout: 2500, retry: { maxRetries: 0 } });
    if (event === 'stop' && semantic.decision === 'redirect' && semantic.nextStep && ledger?.evidence.length) {
      markStopBlocked(key, env);
      return result('deny', semantic.reason, host, event, semantic.nextStep);
    }
    const decision = semantic.decision === 'deny' ? 'deny'
        : semantic.decision === 'allow' || semantic.decision === 'finish' ? 'allow' : 'advise';
    return result(decision, semantic.reason, host, event, semantic.nextStep);
  } catch {
    return result('advise', 'Jev unavailable; retain native permissions and evidence checks.', host, event);
  }
}
