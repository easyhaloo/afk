import { pathToFileURL } from 'node:url';

const events = {
  SessionStart: 'resume-context',
  UserPromptSubmit: 'prompt',
  PreToolUse: 'before-action',
  PostToolUse: 'after-action',
  Stop: 'stop',
};
const claudeEvents = { ...events, PostToolUseFailure: 'after-failure' };

function isOwnHook(hook) {
  return /jev-agent-guard\/(?:current\/)?scripts\/adapters\//.test(String(hook.command ?? ''));
}

export function removeHookConfig(existing) {
  const result = structuredClone(existing);
  if (!result.hooks) return result;
  for (const event of Object.keys(claudeEvents)) {
    if (!Array.isArray(result.hooks[event])) continue;
    result.hooks[event] = result.hooks[event].map(group => ({
      ...group,
      hooks: Array.isArray(group.hooks) ? group.hooks.filter(hook => !isOwnHook(hook)) : group.hooks,
    })).filter(group => !Array.isArray(group.hooks) || group.hooks.length);
    if (result.hooks[event].length === 0) delete result.hooks[event];
  }
  if (Object.keys(result.hooks).length === 0) delete result.hooks;
  return result;
}

export function hasOwnHook(config) {
  return Object.values(config.hooks ?? {}).some(groups => Array.isArray(groups) &&
    groups.some(group => Array.isArray(group.hooks) && group.hooks.some(isOwnHook)));
}

export function mergeHookConfig(existing, host, commandFor) {
  if (host !== 'claude-code' && host !== 'codex') throw new Error(`Unsupported hook host: ${host}`);
  const result = structuredClone(existing);
  result.hooks ??= {};
  for (const [event, kind] of Object.entries(host === 'claude-code' ? claudeEvents : events)) {
    const original = result.hooks[event];
    if (original != null && !Array.isArray(original)) throw new Error(`Invalid ${event} hooks`);
    const groups = (original ?? []).map(group => ({
      ...group,
      hooks: Array.isArray(group.hooks)
        ? group.hooks.filter(hook => !isOwnHook(hook))
        : group.hooks,
    })).filter(group => !Array.isArray(group.hooks) || group.hooks.length);
    groups.push({ matcher: event === 'SessionStart' ? 'compact' : '',
      hooks: [{ type: 'command', command: commandFor(kind) }] });
    result.hooks[event] = groups;
  }
  return result;
}

export function opencodePluginSource(adapterPath) {
  return `export { JevAgentGuard } from ${JSON.stringify(pathToFileURL(adapterPath).href)};\n`;
}

export function supportsOpenCodePlugin(version) {
  const parsed = String(version).trim().match(/^1\.(\d+)\.(\d+)/);
  return Boolean(parsed && (Number(parsed[1]) > 18 || Number(parsed[1]) === 18 && Number(parsed[2]) >= 29));
}
