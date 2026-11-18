import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const text = value => typeof value === 'string' && value.length > 0 && value === value.trim();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function installedSkillScope(metadata) {
  const declarations = metadata.split(/\r?\n/).filter(line => /^(['"]?)(?:recall-scope|afk-recall)\1\s*:/.test(line));
  if (!declarations.length) return undefined;
  if (declarations.length !== 1 || !/^(?:recall-scope|afk-recall):/.test(declarations[0])) return null;
  try {
    const scope = JSON.parse(declarations[0].slice(declarations[0].indexOf(':') + 1));
    if (!record(scope) || Object.keys(scope).some(key => !['project', 'environment', 'productVersions'].includes(key)) ||
        !text(scope.project) || !text(scope.environment) || !record(scope.productVersions)) return null;
    const versions = Object.entries(scope.productVersions);
    if (versions.length === 0 || versions.some(([product, version]) => !text(product) || product === '__proto__' || !text(version))) return null;
    return scope;
  } catch { return null; }
}

export function currentSkillTask(cwd, env) {
  if (!env.AFK_SKILL_TASK_CONTEXT || !path.isAbsolute(cwd)) return;
  try {
    const task = JSON.parse(env.AFK_SKILL_TASK_CONTEXT);
    const root = fs.realpathSync(cwd);
    if (task.workspace !== root || !text(task.runId) || !text(task.taskId)) return;
    const home = fs.realpathSync(env.HOME || env.USERPROFILE);
    const hash = createHash('sha256').update(root).digest('hex');
    const file = path.join(home, '.afk', 'workspaces', hash, 'workspace.json');
    if (fs.realpathSync(file) !== file || !fs.statSync(file).isFile()) return;
    const allocation = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (allocation.root !== root || allocation.cleanupStatus !== 'active' || allocation.taskId !== task.taskId ||
        allocation.currentRunId !== task.runId) return;
    const project = /^(github:[^#\s]+|gitlab:[^#\s]+)#[1-9]\d*$/.exec(task.taskId)?.[1];
    if (!project || project !== task.target?.project || !record(task.target.productVersions)) return;
    return { project, environment: task.applicability?.environment, productVersions: task.target.productVersions };
  } catch { return; }
}

export function matchesSkillScope(scope, task) {
  if (scope === undefined) return true;
  return Boolean(scope && task && record(task.productVersions) && scope.project === task.project && scope.environment === task.environment &&
    Object.entries(scope.productVersions).every(([product, version]) =>
      Object.hasOwn(task.productVersions, product) && task.productVersions[product] === version));
}
