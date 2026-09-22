#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const repoRoot = process.cwd();
const targetDir = path.join(repoRoot, '.claude');
const targetFile = path.join(targetDir, 'settings.json');
const codexDir = path.join(repoRoot, '.codex');
const opencodeDir = path.join(repoRoot, '.opencode');

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

function patchClaudeSettings() {
  const settings = readJson(targetFile, { hooks: {} });
  const current = settings.hooks || {};
  const entry = {\n    type: 'command',\n    command: 'node skills/jev-agent-guard/scripts/adapters/claude-code.mjs pre-tool',\n  };
  const hooks = current.PreToolUse || [];
  if (!hooks.some(item => item.command && item.command.includes('claude-code.mjs'))) {\n    current.PreToolUse = [...hooks, entry];\n  }\n  settings.hooks = current;\n  writeJson(targetFile, settings);\n  console.log(`Updated ${targetFile}`);\n}\n\nfunction patchCodexSettings() {\n  const configFile = path.join(codexDir, 'config.json');\n  const settings = readJson(configFile, { hooks: [] });\n  const hooks = Array.isArray(settings.hooks) ? settings.hooks : [];
  const entry = { type: 'pre-tool', command: 'node skills/jev-agent-guard/scripts/adapters/codex.mjs pre-tool' };
  if (!hooks.some(item => item.command && item.command.includes('codex.mjs'))) hooks.push(entry);\n  settings.hooks = hooks;\n  writeJson(configFile, settings);\n  console.log(`Updated ${configFile}`);\n}\n\nfunction patchOpenCodeSettings() {\n  const configFile = path.join(opencodeDir, 'config.json');\n  const settings = readJson(configFile, { plugins: [] });\n  const plugins = Array.isArray(settings.plugins) ? settings.plugins : [];
  const entry = { name: 'jev-agent-guard', command: 'node skills/jev-agent-guard/scripts/adapters/opencode.mjs' };
  if (!plugins.some(item => item.name === 'jev-agent-guard')) plugins.push(entry);\n  settings.plugins = plugins;\n  writeJson(configFile, settings);\n  console.log(`Updated ${configFile}`);\n}\n
function main() {
  const argv = process.argv.slice(2);
  const host = argv[0] || 'claude-code';
  switch (host) {
    case 'claude-code':
      patchClaudeSettings();
      break;
    case 'codex':
      patchCodexSettings();
      break;
    case 'opencode':
      patchOpenCodeSettings();
      break;
    default:
      console.error('Unsupported host. Use claude-code, codex, or opencode.');
      process.exit(1);
  }
}

main();
