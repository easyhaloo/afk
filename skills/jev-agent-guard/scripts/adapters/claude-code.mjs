#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const claudeSettingsPath = path.join(repoRoot, '.claude', 'settings.json');
const codexConfigPath = path.join(repoRoot, '.codex', 'config.toml');
const opencodeConfigPath = path.join(repoRoot, '.opencode', 'config.json');

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeToml(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
}

function ensureClaudeHook() {
  const settings = readJson(claudeSettingsPath, { hooks: {} });
  const hooks = settings.hooks ?? {};
  const list = hooks.PreToolUse ?? [];
  const command = 'node skills/jev-agent-guard/scripts/adapters/claude-code.mjs pre-tool';
  const exists = list.some(item => item && typeof item.command === 'string' && item.command.includes('claude-code.mjs'));
  if (!exists) {
    list.push({ type: 'command', command });
    hooks.PreToolUse = list;
    settings.hooks = hooks;
    writeJson(claudeSettingsPath, settings);
    console.log(`Updated ${claudeSettingsPath}`);
  } else {
    console.log(`Claude settings already contain the Jev guard hook.`);
  }
}

function ensureCodexHook() {
  const lines = [
    '[hooks]',
    'pre_tool = "node skills/jev-agent-guard/scripts/adapters/codex.mjs pre-tool"',
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
  const current = fs.existsSync(codexConfigPath) ? fs.readFileSync(codexConfigPath, 'utf8') : '';
  if (!current.includes('jev-agent-guard')) {
    fs.writeFileSync(codexConfigPath, current.trim() ? `${current.trim()}\n\n${lines}` : lines, 'utf8');
    console.log(`Updated ${codexConfigPath}`);
  } else {
    console.log(`Codex config already contains the Jev guard hook.`);
  }
}

function ensureOpenCodePlugin() {
  const settings = readJson(opencodeConfigPath, { plugins: [] });
  const plugins = Array.isArray(settings.plugins) ? settings.plugins : [];
  const entry = { name: 'jev-agent-guard', command: 'node skills/jev-agent-guard/scripts/adapters/opencode.mjs' };
  if (!plugins.some(item => item && item.name === 'jev-agent-guard')) {
    plugins.push(entry);
    settings.plugins = plugins;
    writeJson(opencodeConfigPath, settings);
    console.log(`Updated ${opencodeConfigPath}`);
  } else {
    console.log(`OpenCode config already contains the Jev guard plugin.`);
  }
}

function main() {
  ensureClaudeHook();
  ensureCodexHook();
  ensureOpenCodePlugin();
  console.log('Jev Agent Guard install complete.');
  console.log('Set TYPESAFE_API_KEY in your shell before using live policy checks.');
}

main();
