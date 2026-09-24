export interface GitLabProjectLocation {
  host: string;
  projectPath: string;
}

export function normalizeGitLabHost(value: string | undefined): string {
  const raw = value?.trim() || 'gitlab.com';
  const url = /^https?:\/\//i.test(raw) ? new URL(raw) : new URL(`https://${raw}`);
  return url.host.toLowerCase();
}

export function resolveGitLabProjectKey(projectKey: string, providerHost?: string): GitLabProjectLocation {
  const raw = projectKey.trim();
  const host = normalizeGitLabHost(providerHost);
  const prefix = providerHost ? `${host}/` : undefined;
  const projectPath = (prefix && raw.toLowerCase().startsWith(prefix.toLowerCase()) ? raw.slice(prefix.length) : raw)
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/, '');
  if (!projectPath) throw new Error('GitLab project key must include a project path');
  return { host, projectPath };
}

export function gitLabCloneUrl(projectKey: string, providerHost?: string): string {
  const { host, projectPath } = resolveGitLabProjectKey(projectKey, providerHost);
  return `https://${host}/${projectPath}.git`;
}
