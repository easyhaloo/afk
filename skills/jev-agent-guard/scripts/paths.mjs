import os from 'node:os';
import path from 'node:path';

export function resolveRuntimeRoot(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    return path.win32.join(env.LOCALAPPDATA || path.win32.join(env.USERPROFILE || os.homedir(), 'AppData', 'Local'), 'jev-agent-guard');
  }
  return path.join(env.XDG_DATA_HOME || path.join(env.HOME || os.homedir(), '.local', 'share'), 'jev-agent-guard');
}

export function resolveHostPaths(env = process.env, platform = process.platform) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const join = platform === 'win32' ? path.win32.join : path.join;
  return {
    'claude-code': join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json'),
    codex: join(env.CODEX_HOME || join(home, '.codex'), 'hooks.json'),
    opencode: join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode', 'plugins', 'jev-agent-guard.js'),
  };
}
