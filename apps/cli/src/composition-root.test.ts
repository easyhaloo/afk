import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliPluginRuntime } from './composition-root.js';

describe('CLI plugin composition root', () => {
  it('loads built-in capability providers alongside installed plugins', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'afk-plugin-runtime-'));
    const runtime = await createCliPluginRuntime({ homeDir });

    expect(runtime.listProviders('agent.provider')).toEqual(['claude-code', 'codex', 'cursor', 'pi', 'opencode', 'copilot']);
    expect(runtime.listProviders('sandbox.provider')).toEqual(['local', 'docker', 'podman']);
    expect(runtime.listProviders('host.connection')).toEqual(['jumpserver', 'ssh', 'aws-ssm', 'kubernetes-exec']);
    expect(runtime.listProviders('verification.provider')).toEqual(['test-runner', 'static-scan', 'browser-check']);
    expect(runtime.listProviders('notification.provider')).toEqual(['notification.desktop']);
    expect(runtime.listProviders('context.provider')).toEqual(['context.experience', 'context.code', 'context.retrieval', 'context.project-memory']);
    expect(runtime.listProviders('credential.provider')).toEqual(['credential.system-keychain']);
    expect(runtime.listProviders('artifact.provider')).toEqual(['test-report-local']);
    expect(runtime.listProviders('repository.provider')).toEqual(['multi-repository']);
    expect(runtime.listProviders('policy.provider')).toEqual(['secret-scan', 'license-policy', 'compliance-policy']);
  });
});
