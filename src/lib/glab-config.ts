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
 * Supports macOS (~/Library/Application Support) and Linux (~/.config)
 *
 * glab config uses YAML 1.1 !!null tags which js-yaml cannot parse,
 * so we use a simple line-based scanner instead.
 */
export function readGlabConfig(): GlabConfig | null {
  if (cachedGlabConfig) {
    return cachedGlabConfig;
  }

  const possiblePaths = [
    path.join(os.homedir(), 'Library', 'Application Support', 'glab-cli', 'config.yml'),
    path.join(os.homedir(), '.config', 'glab-cli', 'config.yml'),
    path.join(os.homedir(), '.var', 'app', 'com.gitlab嗓音', 'config', 'glab-cli', 'config.yml'),
  ];

  for (const configPath of possiblePaths) {
    if (!fs.existsSync(configPath)) continue;
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = parseGlabConfig(content);
    if (config) {
      cachedGlabConfig = config;
      return cachedGlabConfig;
    }
  }

  return null;
}

/**
 * Line-based glab config parser (YAML 1.1 compatible).
 *
 * glab config structure:
 *   host: gitlab.com
 *   hosts:
 *       hostname:
 *           token: xxx
 *           api_host: hostname
 *           api_protocol: https
 *           user: username
 *       another-host:
 *           ...
 *
 * Ignores lines with YAML 1.1 explicit tags (!<tag:yaml.org,2002:null>).
 */
function parseGlabConfig(content: string): GlabConfig | null {
  const config: GlabConfig = { host: 'gitlab.com', hosts: {} };
  let inHosts = false;       // inside [hosts] section
  let lastHost = '';         // last hostname: line seen at indent >= 2
  let lastKey = '';           // last key: value key at indent >= 4

  for (const rawLine of content.split('\n')) {
    const line = rawLine;
    const trimmed = line.trim();

    // Skip blank/comment/YAML-1.1-tag lines
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.includes('!!null')) {
      lastKey = '';
      continue;
    }

    const indent = line.search(/\S/);
    if (indent < 0) { lastKey = ''; continue; }

    // Top-level: indent 0
    if (indent === 0) {
      inHosts = trimmed === 'hosts:';
      if (trimmed.startsWith('host:')) {
        const v = trimmed.substring(5).trim();
        if (v) config.host = v;
      }
      if (inHosts) { lastHost = ''; lastKey = ''; }
      continue;
    }

    // hostname: at indent >= 2 inside hosts: block
    if (inHosts && indent >= 2 && trimmed.endsWith(':') && !trimmed.includes(' ')) {
      const h = trimmed.replace(/:$/, '').trim();
      if (h) {
        config.hosts[h] = { api_host: h, api_protocol: 'https' };
        lastHost = h;
        lastKey = '';
      }
      continue;
    }

    // key: value at indent >= 4 — assign to lastHost
    if (indent >= 4 && lastHost) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0) {
        const key = trimmed.substring(0, colonIdx).trim();
        const val = trimmed.substring(colonIdx + 1).trim();
        if (val && val !== 'null') {
          if (key === 'token') config.hosts[lastHost].token = val;
          else if (key === 'api_host') config.hosts[lastHost].api_host = val;
          else if (key === 'api_protocol') config.hosts[lastHost].api_protocol = val;
          else if (key === 'user') config.hosts[lastHost].user = val;
        }
        lastKey = key;
      }
      continue;
    }

    lastKey = '';
  }

  return Object.keys(config.hosts).length > 0 ? config : null;
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
