import { getGlabToken } from './glab-config';

interface GitLabConfig {
  url: string;
  token: string;
  projectId: string | number;
}

interface Config {
  gitlab: GitLabConfig;
  refreshInterval: number;
}

const DEFAULT_REFRESH_INTERVAL = 30; // seconds

function loadConfig(): Config {
  // Priority: environment variables > glab config > defaults
  let url = process.env.GITLAB_URL;
  let token = process.env.GITLAB_TOKEN;
  const projectId = process.env.GITLAB_PROJECT_ID;

  // Fallback to glab config
  if (!token) {
    const glab = getGlabToken(url);
    if (glab) {
      url = url || (glab.apiHost.startsWith('http') ? glab.apiHost : `https://${glab.apiHost}`);
      token = glab.token;
    }
  }

  return {
    gitlab: {
      url: url || 'https://gitlab.com',
      token: token || '',
      projectId: projectId || '',
    },
    refreshInterval: parseInt(process.env.AFK_REFRESH_INTERVAL || String(DEFAULT_REFRESH_INTERVAL), 10),
  };
}

let cachedConfig: Config | null = null;

export function getConfig(): { getConfig(): Config } {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return {
    getConfig: () => cachedConfig!,
  };
}
