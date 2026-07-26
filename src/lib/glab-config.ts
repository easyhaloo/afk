import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface GlabHostConfig {
  api_host: string;
  api_protocol: string;
  token?: string;
  user?: string;
}

export interface GlabConfig {
  host: string;
  hosts: Record<string, GlabHostConfig>;
}

let cachedGlabConfig: GlabConfig | null = null;

/**
 * Read glab CLI configuration
 * Supports both macOS (~/Library/Application Support) and Linux (~/.config)
 */
export function readGlabConfig(): GlabConfig | null {
  if (cachedGlabConfig) {
    return cachedGlabConfig;
  }

  // Try different paths for glab config
  const possiblePaths = [
    // macOS
    path.join(os.homedir(), 'Library', 'Application Support', 'glab-cli', 'config.yml'),
    // Linux
    path.join(os.homedir(), '.config', 'glab-cli', 'config.yml'),
    // Flatpak
    path.join(os.homedir(), '.var', 'app', 'com.gitlab嗓音', 'config', 'glab-cli', 'config.yml'),
  ];

  for (const configPath of possiblePaths) {
    try {
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, 'utf-8');
        cachedGlabConfig = parseGlabYaml(content);
        return cachedGlabConfig;
      }
    } catch {
      // Continue to next path
    }
  }

  return null;
}

/**
 * Simple YAML parser for glab config (only handles the subset we need)
 */
function parseGlabYaml(content: string): GlabConfig {
  const config: GlabConfig = {
    host: 'gitlab.com',
    hosts: {},
  };

  const lines = content.split('\n');
  let currentHost: string | null = null;
  let inHosts = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (trimmed.startsWith('#') || trimmed === '') {
      continue;
    }

    // Top-level host setting
    if (trimmed.startsWith('host:')) {
      config.host = trimmed.substring(5).trim();
      continue;
    }

    // Check if we're entering hosts section
    if (trimmed === 'hosts:') {
      inHosts = true;
      continue;
    }

    // Indent level check - hosts section ends when we dedent
    if (inHosts && trimmed.startsWith(' ') && !trimmed.startsWith('  ')) {
      inHosts = false;
      currentHost = null;
    }

    // Host entry
    if (inHosts && trimmed.match(/^[a-zA-Z0-9_.-]+:$/)) {
      currentHost = trimmed.replace(':', '');
      if (!config.hosts[currentHost]) {
        config.hosts[currentHost] = {
          api_host: currentHost,
          api_protocol: 'https',
        };
      }
      continue;
    }

    // Host properties
    if (currentHost && trimmed.startsWith('token:')) {
      const token = trimmed.substring(6).trim();
      if (token && token !== 'null') {
        config.hosts[currentHost].token = token;
      }
      continue;
    }

    if (currentHost && trimmed.startsWith('api_host:')) {
      config.hosts[currentHost].api_host = trimmed.substring(9).trim();
      continue;
    }

    if (currentHost && trimmed.startsWith('api_protocol:')) {
      config.hosts[currentHost].api_protocol = trimmed.substring(13).trim();
      continue;
    }

    if (currentHost && trimmed.startsWith('user:')) {
      config.hosts[currentHost].user = trimmed.substring(5).trim();
      continue;
    }
  }

  return config;
}

/**
 * Resolve GitLab host/token for service constructors: prefers env vars,
 * falls back to the best glab CLI config. Returns a fully-resolved
 * `{ host, token }` ready to feed into `new Gitlab({...})`.
 */
export function applyGlabConfig(): { host: string; token: string } | null {
  let url = process.env.GITLAB_URL;
  let token = process.env.GITLAB_TOKEN;

  if (!token) {
    const glab = getGlabToken(url);
    if (glab) {
      url = url || (glab.apiHost.startsWith('http') ? glab.apiHost : `https://${glab.apiHost}`);
      token = glab.token;
    }
  }

  if (!token) return null;
  return { host: url || '', token };
}

/**
 * Get the best GitLab token from glab config
 * Priority: specified host > default host > first available
 */
export function getGlabToken(preferredHost?: string): { host: string; token: string; apiHost: string } | null {
  const glabConfig = readGlabConfig();
  if (!glabConfig) {
    return null;
  }

  let host = preferredHost || glabConfig.host;
  let hostConfig = glabConfig.hosts[host];

  // If preferred host not found, try default host
  if (!hostConfig && host !== glabConfig.host) {
    host = glabConfig.host;
    hostConfig = glabConfig.hosts[host];
  }

  // Find first host with a token
  if (!hostConfig?.token) {
    for (const [h, cfg] of Object.entries(glabConfig.hosts)) {
      if (cfg.token) {
        host = h;
        hostConfig = cfg;
        break;
      }
    }
  }

  if (!hostConfig?.token) {
    return null;
  }

  return {
    host,
    token: hostConfig.token,
    apiHost: hostConfig.api_host || host,
  };
}
