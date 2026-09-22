#!/usr/bin/env node
/**
 * Minimal, dependency-free TypeSafe Jev client for this skill.
 *
 * It is intentionally a transport client, not a policy engine. Callers must
 * redact secrets and apply local policy before asking Jev for a judgment.
 */

const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-latest';

export class JevError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'JevError';
    this.code = options.code ?? 'jev_error';
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

export class JevClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
    this.endpoint = options.endpoint ?? process.env.TYPESAFE_ENDPOINT ?? DEFAULT_ENDPOINT;
    this.model = options.model ?? process.env.JEV_MODEL ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? 4000;
    this.fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.fetch !== 'function') {
      throw new JevError('A fetch implementation is required', { code: 'fetch_unavailable' });
    }
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  async ask({ state = {}, questions = [], metadata = {} } = {}) {
    if (!this.apiKey) throw new JevError('TYPESAFE_API_KEY is not configured', { code: 'missing_api_key' });
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new JevError('At least one typed question is required', { code: 'invalid_questions' });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: this.model, state, questions, metadata }),
        signal: controller.signal,
      });
      const text = await response.text();
      let body;
      try { body = text ? JSON.parse(text) : {}; } catch {
        throw new JevError('Jev returned invalid JSON', { code: 'invalid_response', status: response.status });
      }
      if (!response.ok) {
        throw new JevError(body?.error?.message ?? `Jev request failed with HTTP ${response.status}`, {
          code: response.status === 429 || response.status >= 500 ? 'provider_retryable' : 'provider_error',
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
      }
      return body;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new JevError(`Jev request timed out after ${this.timeoutMs}ms`, { code: 'timeout', retryable: true });
      }
      if (error instanceof JevError) throw error;
      throw new JevError(error?.message ?? String(error), { code: 'network_error', retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  async choice({ state, prompt, options, metadata } = {}) {
    if (!Array.isArray(options) || options.length < 2) {
      throw new JevError('choice requires at least two options', { code: 'invalid_options' });
    }
    return this.ask({
      state,
      metadata,
      questions: [{ type: 'choice', prompt, options }],
    });
  }

  async noul({ state, prompt, metadata } = {}) {
    return this.ask({
      state,
      metadata,
      questions: [{ type: 'noul', prompt }],
    });
  }
}

export function redact(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]')
    .replace(/((?:token|secret|password|passwd|api[_-]?key|authorization)\s*[:=]\s*)[^\s,}]+/gi, '$1[REDACTED]')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[REDACTED_PRIVATE_KEY]');
}

export function createJevClient(options = {}) {
  return new JevClient(options);
}
