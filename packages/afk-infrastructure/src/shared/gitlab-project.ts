export interface GitLabProjectLocation {
  host: string;
  projectPath: string;
}

export function normalizeGitLabHost(value: string | undefined): string {
  const raw = value?.trim() || 'gitlab.com';
  const url = /^https?:\/\//i.test(raw) ? new URL(raw) : new URL(`https://${raw}`);
  return url.host.toLowerCase();
}

/**
 * The base URL of a GitLab instance.
 *
 * A GitLab can be installed under a path — `https://example.com/gitlab` —
 * and its API lives under that path too. Reducing an instance to its origin
 * drops the path and sends every API call to the wrong place, so the base
 * keeps it.
 */
export function gitLabBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || 'https://gitlab.com';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, '');
}

/**
 * The URL of an API path on a GitLab instance.
 *
 * The path is resolved against the instance's base, not against its origin,
 * so an instance under a path is asked under that path.
 */
export function gitLabApiUrl(baseUrl: string, pathname: string): string {
  const base = gitLabBaseUrl(baseUrl);
  return new URL(pathname.replace(/^\/+/, ''), `${base}/`).toString();
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
