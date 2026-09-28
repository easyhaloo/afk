import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function sanitize(text) {
  return text.replace(/\b(password|token|secret|api[_-]?key)\s*[:=]\s*[^\s'"`]+/gi, '$1=[redacted]')
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}\b/g, '[redacted]');
}

function frontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match?.[1] ?? '';
}

function field(source, name) {
  const lines = source.split(/\r?\n/);
  const index = lines.findIndex(line => line.startsWith(`${name}:`));
  if (index < 0) return '';
  const value = lines[index].slice(name.length + 1).trim();
  if (value !== '>-' && value !== '|') return value.replace(/^['"]|['"]$/g, '');
  const continuation = [];
  for (const line of lines.slice(index + 1)) {
    if (line && !/^\s/.test(line)) break;
    if (line.trim()) continuation.push(line.trim());
  }
  return continuation.join(' ');
}

export function extractContract(source) {
  const metadata = frontmatter(source);
  const body = source.slice(source.indexOf('---', 4) + 3);
  const lines = body.split(/\r?\n/);
  const steps = [];
  const constraints = [];
  let inSteps = false;
  for (const line of lines) {
    if (/^##\s/.test(line)) inSteps = /^##\s+(?:Steps\b|步骤(?:\s|$))/i.test(line);
    if (inSteps) {
      const step = line.match(/^\s*(?:\d+[.)]|-\s+\*\*Step\b[^:]*:)\s*(.+)/i);
      if (step && steps.length < 12) steps.push(sanitize(step[1]).slice(0, 160));
    }
    if (/\b(?:MUST(?: NOT)?|NEVER|REQUIRED)\b/i.test(line) && constraints.length < 12) {
      constraints.push(sanitize(line.replace(/^\s*[-*]\s*/, '')).slice(0, 160));
    }
  }
  return { name: field(metadata, 'name').slice(0, 80), description: sanitize(field(metadata, 'description')).slice(0, 240), steps, constraints };
}

export function listSkillMetadata(roots) {
  const skills = new Map();
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const item of fs.readdirSync(root, { withFileTypes: true })) {
      if (!item.isDirectory() && !item.isSymbolicLink()) continue;
      const file = path.join(root, item.name, 'SKILL.md');
      try {
        if (fs.statSync(file).size > 65536) continue;
        const { name, description } = extractContract(fs.readFileSync(file, 'utf8'));
        if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) && !skills.has(name)) skills.set(name, { name, description, file });
      } catch { continue; }
    }
  }
  return [...skills.values()];
}

export function findSkill(catalog, name) {
  return catalog.find(skill => skill.name === name);
}

export function skillRoots(host, projectRoot, env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const config = env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  if (host === 'claude-code') return [path.join(projectRoot, '.claude/skills'), path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), 'skills')];
  if (host === 'codex') return [path.join(projectRoot, '.agents/skills'), path.join(home, '.agents/skills'), path.join(env.CODEX_HOME ?? path.join(home, '.codex'), 'skills')];
  return [path.join(projectRoot, '.opencode/skills'), path.join(config, 'opencode/skills')];
}

export async function recommendSkill(prompt, catalog, choose) {
  const cleaned = prompt.slice(0, 2000).replace(/\b(?:password|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '');
  const terms = [...new Set((cleaned.toLowerCase().match(/[\p{L}\p{N}-]{3,}/gu) ?? []).slice(0, 32))];
  const ranked = catalog.map(skill => ({ skill, score: terms.filter(term => `${skill.name} ${skill.description}`.toLowerCase().includes(term)).length }))
    .filter(item => item.score > 0).sort((left, right) => right.score - left.score).slice(0, 5);
  if (!ranked.length) return null;
  if (ranked.length === 1 || ranked[0].score > ranked[1].score) return ranked[0].skill.name;
  const state = { terms, candidates: ranked.map(item => ({ name: item.skill.name })) };
  try {
    const selected = await choose(state);
    return ranked.some(item => item.skill.name === selected) ? selected : ranked[0].skill.name;
  } catch { return ranked[0].skill.name; }
}
