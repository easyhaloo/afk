#!/usr/bin/env node
/**
 * Native TypeSafe SDK facade for the Jev Agent Guard skill.
 *
 * This file deliberately contains no HTTP implementation. Install the skill's
 * package.json first, then import the official @typesafe-ai/sdk package.
 */
import { choice, noul, score, TypeSafeClient } from '@typesafe-ai/sdk';

export { choice, noul, score, TypeSafeClient };

export class JevClientError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'JevClientError';
    this.code = options.code ?? 'jev_error';
    this.cause = options.cause;
  }
}

export function createJevClient(options = {}) {
  if (!process.env.TYPESAFE_API_KEY && !options.apiKey) {
    throw new JevClientError('TYPESAFE_API_KEY is not configured', { code: 'missing_api_key' });
  }

  // The native SDK reads TYPESAFE_API_KEY from the environment. Pass only
  // documented client options supplied by the caller; never log credentials.
  return new TypeSafeClient(options);
}

export async function askJev({ state, questions, client, options } = {}) {
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
    throw new JevClientError('questions must be an object created with choice/noul/score helpers', {
      code: 'invalid_questions',
    });
  }

  const activeClient = client ?? createJevClient(options);
  try {
    return await activeClient.systemOne({ state, questions });
  } catch (error) {
    throw new JevClientError(error?.message ?? String(error), {
      code: error?.code ?? 'provider_error',
      cause: error,
    });
  }
}

export async function decideChoice({ state, name = 'decision', prompt, options, client, clientOptions } = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new JevClientError('options must be a keyed object of choice criteria', { code: 'invalid_options' });
  }
  const response = await askJev({
    state,
    client,
    options: clientOptions,
    questions: { [name]: choice(prompt, options) },
  });
  return response.answers[name];
}

export async function decideNoul({ state, name = 'decision', prompt, client, clientOptions } = {}) {
  const response = await askJev({
    state,
    client,
    options: clientOptions,
    questions: { [name]: noul(prompt) },
  });
  return response.answers[name];
}

export async function decideScore({ state, name = 'decision', prompt, levels, client, clientOptions } = {}) {
  if (!Array.isArray(levels) || levels.length < 2) {
    throw new JevClientError('levels must contain at least two score criteria', { code: 'invalid_levels' });
  }
  const response = await askJev({
    state,
    client,
    options: clientOptions,
    questions: { [name]: score(prompt, levels) },
  });
  return response.answers[name];
}
