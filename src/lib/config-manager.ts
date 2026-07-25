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
  return {
    gitlab: {
      url: process.env.GITLAB_URL || 'https://gitlab.com',
      token: process.env.GITLAB_TOKEN || '',
      projectId: process.env.GITLAB_PROJECT_ID || '',
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
