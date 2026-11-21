import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

const hosted = process.platform === 'linux' && process.env.RUNNER_ENVIRONMENT === 'github-hosted'
  && process.env.GITHUB_JOB === 'cli';

it.runIf(hosted || process.env.AFK_TEST_NATIVE_PODMAN === '1')('sandbox.podman executes on native local libpod', () => {
  const script = fileURLToPath(new URL('./podman-native.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [script], { encoding: 'utf8', timeout: 120_000,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
      GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT } });
  console.log(output.trim());
}, 130_000);
