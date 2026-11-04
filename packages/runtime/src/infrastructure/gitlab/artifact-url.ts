/**
 * GitLab serves uploaded attachments from its own upload route
 * (`/<namespace>/<project>/uploads/:secret/:filename`), never from the
 * repository.
 *
 * The markdown renderer rewrites every relative link that looks like a
 * repository path into `/-/blob/<ref>/...`. A root-relative upload path is
 * indistinguishable from such a repository path, so it is rewritten too and
 * the link ends up pointing at a repository file that does not exist. Only an
 * absolute URL survives rendering untouched.
 *
 * A relative upload path therefore has to be resolved against the instance
 * base URL before it is written into a description.
 */
export function resolveGitLabArtifactUrl(raw: string | undefined, instanceUrl: string): string {
  const trimmed = raw?.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const base = gitLabBaseUrl(instanceUrl);
  return `${base}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
}

/**
 * The instance base URL including a subfolder installation prefix, with a
 * scheme. `GITLAB_URL` may be configured as a bare host name.
 */
function gitLabBaseUrl(instanceUrl: string): string {
  const raw = instanceUrl.trim() || 'https://gitlab.com';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withScheme);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
