import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { load } from 'js-yaml';

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
 * Read glab CLI configuration.
 * Supports macOS (~/Library/Application Support) and Linux (~/.config).
 *
 * glab config uses YAML 1.1 explicit null tags (!!null) which standard
 * parsers reject. We preprocess to strip !!null tags before parsing.
 */
export function readGlabConfig(): GlabConfig | null {
  if (cachedGlabConfig) {
    return cachedGlabConfig;
  }

  const possiblePaths = [
    path.join(os.homedir(), 'Library', 'Application Support', 'glab-cli', 'config.yml'),
    path.join(os.homedir(), '.config', 'glab-cli', 'config.yml'),
    path.join(os.homedir(), '.var', 'app', 'com.gitlab.GitLabClient', 'config', 'glab-cli', 'config.yml'),
  ];

  for (const configPath of possiblePaths) {
    if (!fs.existsSync(configPath)) continue;
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = parseGlabConfig(raw);
    if (config) {
      cachedGlabConfig = config;
      return cachedGlabConfig;
    }
  }

  return null;
}

/**
 * Parse glab config YAML content.
 * Preprocesses !!null YAML 1.1 explicit tags before parsing.
 */
function parseGlabConfig(raw: string): GlabConfig | null {
  const content = raw.replace(/!!null\b\s*/g, '');
  let parsed: any;
  try {
    parsed = load(content);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;

  const config: GlabConfig = {
    host: parsed.host || 'gitlab.com',
    hosts: {},
  };

  if (parsed.hosts && typeof parsed.hosts === 'object') {
    for (const [name, cfg] of Object.entries(parsed.hosts as Record<string, any>)) {
      config.hosts[name] = {
        api_host: cfg?.api_host || name,
        api_protocol: cfg?.api_protocol || 'https',
        token: cfg?.token,
        user: cfg?.user,
      };
    }
  }

  return Object.keys(config.hosts).length > 0 ? config : null;
}

/**
 * Get the best GitLab token from glab config.
 * Priority: preferredHost > default host > first host with a token.
 */
export function getGlabToken(preferredHost?: string): { host: string; token: string; apiHost: string } | null {
  const cfg = readGlabConfig();
  if (!cfg) return null;

  let host = preferredHost || cfg.host;
  let hostCfg = cfg.hosts[host];

  if (!hostCfg && host !== cfg.host) {
    host = cfg.host;
    hostCfg = cfg.hosts[host];
  }

  if (!hostCfg?.token) {
    for (const [h, c] of Object.entries(cfg.hosts)) {
      if (c.token) { host = h; hostCfg = c; break; }
    }
  }

  if (!hostCfg?.token) return null;

  return { host, token: hostCfg.token!, apiHost: hostCfg.api_host || host };
}

/**
 * Sync wrapper: resolves GitLab host/token from env or glab config.
 */
export function applyGlabConfig(): { host: string; token: string } | null {
  const url = process.env.GITLAB_URL;
  const token = process.env.GITLAB_TOKEN;
  if (token) {
    return { host: url || 'https://gitlab.com', token };
  }
  const glab = getGlabToken(url);
  if (!glab) return null;
  const host = glab.apiHost.startsWith('http') ? glab.apiHost : `https://${glab.apiHost}`;
  return { host, token: glab.token };
}
