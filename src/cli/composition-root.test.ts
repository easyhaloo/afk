import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCliRuntimePorts } from './composition-root.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function projectWithConfig(config: string): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), 'afk-runtime-ports-'));
  roots.push(project);
  await mkdir(join(project, '.afk'), { recursive: true });
  await writeFile(join(project, '.afk', 'config.yml'), config, 'utf8');
  return project;
}

describe('the CLI composition root', () => {
  it('wires the configuration port to the configuration the runtime reads', async () => {
    // A port with nothing behind it answers from memory, and the whole
    // point of the composition root is that the port is answered by the
    // runtime: the file the runner reads is the file the port reads.
    const project = await projectWithConfig('maxRetries: 9\n');

    const ports = await createCliRuntimePorts();

    expect(ports.configuration.workflow(project).maxRetries).toBe(9);
  });

  it('answers the scheduler and the tracker through the same port', async () => {
    const ports = await createCliRuntimePorts();

    expect(ports.configuration.scheduler().maxConcurrent).toBeGreaterThan(0);
    expect(ports.configuration.gitLab().url).toBeTypeOf('string');
  });
});
