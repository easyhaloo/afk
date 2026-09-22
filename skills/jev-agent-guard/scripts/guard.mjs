#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AUDIT_DIR = path.join(os.homedir(), '.afk', 'jev-agent-guard');
const AUDIT_FILE = path.join(AUDIT_DIR, 'audit.jsonl');
const SECRET_PATTERNS = [
  /(?:token|secret|password|passwd|api[_-]?key|private[_-]?key)/i,
  /\.env(?:\.|$)/i,
  /\.pem$/i,
  /\.npmrc$/i,
  /connection[_-]?string/i,
];
const DESTRUCTIVE_PATTERNS = [
  /git\s+(?:push\s+--force|reset\s+--hard|checkout\s+--\s+\.|clean\s+-fd|branch\s+-D)/i,
  /rm\s+-rf/i,
  /sudo\s+/i,
  /chmod\s+777/i,
  /force-push/i,
];
const NETWORK_PATTERNS = [\n  /\b(?:curl|wget|fetch|http|https)\b/i,\n  /git\s+clone\b/i,\n  /npm\s+(?:install|exec|i)\b/i,\n  /pnpm\s+(?:add|install|dlx)/i,\n  /pip\s+install\b/i,\n  /uv\s+pip\s+install\b/i,\n];

function normalizePathValue(value) {\n  if (!value) return undefined;\n  return String(value);\n}\n\nfunction readJsonFile(filePath) {\n  try {\n    const raw = fs.readFileSync(filePath, 'utf8');\n    return JSON.parse(raw);\n  } catch {\n    return null;\n  }\n}\n\nfunction writeAudit(entry) {\n  try {\n    fs.mkdirSync(AUDIT_DIR, { recursive: true });\n    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(entry)}\n`, 'utf8');\n  } catch {\n    // best effort only\n  }\n}\n\nfunction safeText(input) {\n  return [input].flat().filter(Boolean).join(' ');\n}\n\nfunction classifyAction(action = {}) {\n  const text = safeText([action.tool, action.command, action.path, action.target, action.data, action.prompt]);\n  const classes = [];\n\n  if (action.credential || SECRET_PATTERNS.some(p => p.test(text))) classes.push('credential');\n  if (action.destructive || DESTRUCTIVE_PATTERNS.some(p => p.test(text))) classes.push('destructive');\n  if (action.network || NETWORK_PATTERNS.some(p => p.test(text))) classes.push('network');\n  if (action.externalCode || /(?:curl\s+.*\|\s*(?:bash|sh)|wget\s+.*\|\s*(?:bash|sh)|npx\s+-y|npm\s+exec)/i.test(text)) classes.push('external-code');\n  if (action.policyChange || /(?:\.github\/workflows|ci|deploy|hooks|permissions|security)/i.test(text)) classes.push('policy-change');\n\n  if (action.path && !action.path.startsWith('.')) {\n    classes.push('workspace-scoped');\n  }\n\n  if (classes.length === 0) classes.push('local');\n\n  return classes;\n}\n\nfunction makeDecision(action, options = {}) {\n  const classes = classifyAction(action);\n  const text = safeText([action.tool, action.command, action.path, action.target, action.data]);\n\n  if (classes.includes('credential')) {\n    return { decision: 'deny', action: 'block', dimension: 'permission', reason: 'credential or secret access is denied', source: 'local-policy', classes, requireUser: true };\n  }\n\n  if (classes.includes('destructive') || classes.includes('external-code')) {\n    return { decision: 'deny', action: 'block', dimension: 'permission', reason: 'unsafe destructive or external-code action', source: 'local-policy', classes, requireUser: true };\n  }\n\n  if (classes.includes('policy-change') || classes.includes('network')) {\n    return { decision: 'confirm', action: 'ask-user', dimension: 'permission', reason: 'requires explicit user approval before proceeding', source: 'local-policy', classes, requireUser: true };\n  }\n\n  if (classes.includes('local') && !options.forceCheck) {\n    return { decision: 'allow', action: 'continue', dimension: 'permission', reason: 'bounded local action', source: 'local-policy', classes, requireUser: false };\n  }\n\n  return { decision: 'warn', action: 'continue', dimension: 'permission', reason: 'unclear but bounded risk; keep the scope narrow', source: 'local-policy', classes, requireUser: false };\n}\n\nfunction normalizePayload(payload) {\n  if (!payload || typeof payload !== 'object') return { tool: 'Unknown', command: '', path: '', target: '', data: '' };
  const direct = payload.tool_input || payload.action || payload.input || {};
  const tool = payload.tool_name || payload.tool || direct.tool || 'Unknown';
  const command = payload.command || direct.command || direct.cmd || '';
  const pathValue = normalizePathValue(payload.path || direct.path || payload.target || direct.target || '');
  const target = normalizePathValue(payload.target || direct.target || '');
  const data = payload.data || direct.data || payload.text || direct.text || '';
  return { tool, command, path: pathValue, target, data };
}\n\nfunction handleCheck(args) {\n  const action = {\n    tool: args.tool || 'Unknown',\n    command: args.command || '',\n    path: args.path || '',\n    target: args.target || '',\n    data: args.data || '',\n    credential: !!args.credential,\n    destructive: !!args.destructive,\n    network: !!args.network,\n    externalCode: !!args.externalCode,\n    policyChange: !!args.policyChange,\n  };
  const decision = makeDecision(action, { forceCheck: args.forceCheck });
  const payload = { ...decision, tool: action.tool, command: action.command, path: action.path, target: action.target };
  writeAudit({ timestamp: new Date().toISOString(), ...payload });
  if (args.json) console.log(JSON.stringify(payload, null, 2)); else console.log(`${payload.decision}: ${payload.reason}`);
  if (payload.decision === 'deny' || payload.decision === 'confirm') process.exitCode = 3;
}\n\nfunction handleGuard(args) {\n  let raw = '';
  if (args.jsonFile) {\n    raw = fs.readFileSync(args.jsonFile, 'utf8');\n  } else {\n    raw = fs.readFileSync(0, 'utf8');\n  }
  let payload = {};
  try { payload = JSON.parse(raw); } catch (error) {\n    const decision = { decision: 'deny', action: 'block', dimension: 'permission', reason: `invalid JSON payload: ${String(error.message || error)}`, source: 'guard-input', classes: ['invalid-input'], requireUser: true };
    writeAudit({ timestamp: new Date().toISOString(), ...decision });\n    console.log(JSON.stringify(decision, null, 2));\n    process.exit(2);\n    return;\n  }
  const action = normalizePayload(payload);
  const decision = makeDecision(action);
  const result = { ...decision, hook: decision.decision === 'allow' ? 'allow' : 'block', host: args.host || 'generic' };
  writeAudit({ timestamp: new Date().toISOString(), ...result, command: action.command, tool: action.tool });\n  if (args.json) console.log(JSON.stringify(result, null, 2)); else console.log(`${result.decision}: ${result.reason}`);
  if (result.decision === 'deny' || result.decision === 'confirm') process.exitCode = 3;
}\n\nfunction handleSkillCheck(args) {\n  const source = args.stateFile ? readJsonFile(args.stateFile) : null;
  const state = source || { completed_steps: [], required_steps: [], recent_actions: [] };
  const required = Array.isArray(state.required_steps) ? state.required_steps : [];
  const completed = new Set(Array.isArray(state.completed_steps) ? state.completed_steps : []);
  const missing = required.filter(step => !completed.has(step));
  const status = missing.length === 0 ? 'pass' : 'redirect';
  const payload = {\n    dimension: 'skill-compliance',\n    decision: status,\n    reason: missing.length ? `missing required steps: ${missing.join(', ')}` : 'all required skill steps are complete',\n    missing_steps: missing,\n    completed_steps: Array.from(completed),\n  };
  if (args.json) console.log(JSON.stringify(payload, null, 2)); else console.log(`${payload.decision}: ${payload.reason}`);
  if (status === 'redirect') process.exitCode = 3;
}\n\nfunction handleTrajectory(args) {\n  const state = args.stateFile ? readJsonFile(args.stateFile) : null;\n  const events = Array.isArray(state?.events) ? state.events : [];\n  const repeatedAttempts = events.filter((item, index) => index > 0 && item.command === events[index - 1]?.command && item.result === 'failed').length;
  const payload = {\n    dimension: 'trajectory',\n    decision: repeatedAttempts > 1 ? 'redirect' : 'allow',\n    reason: repeatedAttempts > 1 ? 'same failed commands are repeating; stop and reconsider the hypothesis' : 'trajectory is stable',\n    repeated_attempts: repeatedAttempts,\n    events_seen: events.length,\n  };
  if (args.json) console.log(JSON.stringify(payload, null, 2)); else console.log(`${payload.decision}: ${payload.reason}`);\n  if (payload.decision === 'redirect') process.exitCode = 3;\n}\n\nfunction handleContext(args) {\n  const input = args.inputFile ? readJsonFile(args.inputFile) : null;\n  const source = input || { messages: [], summary: '' };
  const messages = Array.isArray(source.messages) ? source.messages : [];
  const keep = messages.slice(-8);
  const payload = {\n    dimension: 'context',\n    decision: 'compact',\n    total_messages: messages.length,\n    kept_messages: keep.length,\n    kept_preview: keep.map(item => typeof item === 'string' ? item.slice(0, 200) : JSON.stringify(item).slice(0, 200)),\n  };
  if (args.json) console.log(JSON.stringify(payload, null, 2)); else console.log(`compact: kept ${keep.length} of ${messages.length} recent context items`);\n}\n\nfunction handlePolicy() {\n  const payload = {\n    schema_version: 1,\n    decision: 'allow',\n    dimension: 'policy',\n    policy: {\n      local_read: 'allow',\n      local_write: 'allow',\n      local_exec: 'allow',\n      network: 'confirm',\n      credential: 'deny',\n      destructive: 'deny',\n      external_code: 'deny',\n      policy_change: 'confirm',\n    },\n    jev_advisory: true,\n    audit_file: AUDIT_FILE,\n  };\n  console.log(JSON.stringify(payload, null, 2));\n}\n\nfunction handleDoctor() {\n  const host = process.env.CLAUDE_CODE || process.env.CODEX || process.env.OPENCODE ? 'host-detected' : 'generic';\n  const payload = {\n    host,\n    node: process.version,\n    skill_directory: true,\n    hooks_supported: true,\n    jev_available: !!process.env.JEV_API_URL || !!process.env.TYPESAFE_API_KEY,\n    status: 'ready',\n  };\n  console.log(JSON.stringify(payload, null, 2));\n}\n\nfunction handleAudit(args) {\n  const limit = Number(args.limit || 20);
  try {\n    const out = fs.readFileSync(AUDIT_FILE, 'utf8').trim();\n    const items = out ? out.split('\n').filter(Boolean).slice(-limit) : [];\n    console.log(items.join('\n') || '[]');\n  } catch {\n    console.log('[]');\n  }\n}\n\nfunction main() {\n  const argv = process.argv.slice(2);\n  const command = argv[0] || 'doctor';\n  const args = parseArgs(argv.slice(1));\n\n  switch (command) {\n    case 'check': handleCheck(args); break;\n    case 'guard': handleGuard(args); break;\n    case 'skill-check': handleSkillCheck(args); break;\n    case 'trajectory': handleTrajectory(args); break;\n    case 'context': handleContext(args); break;\n    case 'policy': handlePolicy(); break;\n    case 'audit': handleAudit(args); break;\n    case 'doctor': handleDoctor(); break;\n    default:\n      console.error('Unknown command. Available: check, guard, skill-check, trajectory, context, policy, audit, doctor');\n      process.exit(1);\n  }\n}\n\nfunction parseArgs(items) {\n  const out = {};\n  for (let index = 0; index < items.length; index += 1) {\n    const value = items[index];\n    if (!value.startsWith('--')) continue;\n    const key = value.slice(2);\n    const next = items[index + 1];\n    if (next && !next.startsWith('--')) {\n      out[key] = next;\n      index += 1;\n    } else {\n      out[key] = true;\n    }\n  }\n  return out;\n}\n\nmain();\n