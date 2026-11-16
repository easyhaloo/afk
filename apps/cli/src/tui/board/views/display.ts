/** Compact visual vocabulary shared by every dashboard view. */
const GITHUB_ICON = 'GH';
const GITLAB_ICON = 'GL';
const GEELIB_ICON = 'GE';

export function getStatusIcon(status: string): string {
  switch (status) {
    case 'ready': return '○';
    case 'in_progress': return '▶';
    case 'verification': return '◌';
    case 'merge_ready': return '⇥';
    case 'rework': return '↺';
    case 'blocked': return '!';
    case 'done': return '✓';
    case 'prd': return '◈';
    case 'active': return '●';
    case 'stale': return '!';
    case 'error': return '!';
    case 'project': return '◆';
    case 'project_github': return GITHUB_ICON;
    case 'project_gitlab': return GITLAB_ICON;
    case 'project_geelib': return GEELIB_ICON;
    default: return '•';
  }
}

export function getStatusColor(status: string): string {
  switch (status) {
    case 'blocked':
    case 'stale': return 'red';
    case 'error': return 'red';
    case 'in_progress':
    case 'active':
    case 'rework': return 'yellow';
    case 'verification': return 'magenta';
    case 'merge_ready': return 'blue';
    case 'done': return 'green';
    case 'ready': return 'cyan';
    case 'project': return 'gray';
    case 'project_github': return 'white';
    case 'project_gitlab': return 'magenta';
    case 'project_geelib': return 'blue';
    default: return 'white';
  }
}

export type ProjectPlatform = 'github' | 'gitlab' | 'geelib';

export function getProjectPlatformIcon(platform: ProjectPlatform | undefined): string {
  switch (platform) {
    case 'github': return GITHUB_ICON;
    case 'geelib': return GEELIB_ICON;
    default: return GITLAB_ICON;
  }
}

export function getProjectPlatformColor(platform: ProjectPlatform | undefined): string {
  switch (platform) {
    case 'github': return 'white';
    case 'geelib': return 'blue';
    default: return 'magenta';
  }
}

export function getBranchColor(branch: string, defaultBranch?: string): string {
  if (!branch || branch === '–' || branch === '-') return 'yellow';
  if (defaultBranch && branch === defaultBranch) return 'green';
  if (/^(feature|bugfix|hotfix|release)\//.test(branch)) return 'blue';
  return 'cyan';
}

export function getExecutionModeIcon(mode: string): string | undefined {
  switch (mode) {
    case 'afk':
    case 'batch': return '⚙';
    case 'hitl':
    case 'interactive': return '◇';
    default: return undefined;
  }
}

export function getExecutionModeColor(mode: string): string {
  switch (mode) {
    case 'afk':
    case 'batch': return 'cyan';
    case 'hitl':
    case 'interactive': return 'yellow';
    default: return 'gray';
  }
}
