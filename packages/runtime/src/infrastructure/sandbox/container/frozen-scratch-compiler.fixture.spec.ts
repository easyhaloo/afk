import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { captureFrozenScratchHelper } from './frozen-input.js';

export const scratchCompilerImage = process.env.AFK_TEST_FROZEN_SCRATCH_COMPILER_IMAGE
  ?? 'sha256:eb5d9c60d047664130b3c88bb9d3ff77cf809b4a524ee05aa3ac898940332d39';
export const scratchCompilerLabel = 'afk.scratch.s1=offline-helper';

export function compileScratchFixture(path: string, source: Uint8Array = readFileSync(new URL('./frozen-scratch-helper.c', import.meta.url))) {
  if (!/^sha256:[a-f0-9]{64}$/.test(scratchCompilerImage)) {
    throw new Error('AFK_TEST_FROZEN_SCRATCH_COMPILER_IMAGE must be an exact local image ID');
  }
  const encoded = execFileSync('docker', ['run', '--rm', '--interactive', '--pull=never', '--label', scratchCompilerLabel,
    '--read-only', '--user', '1000:1000', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '64', '--memory', '268435456', '--memory-swap', '268435456', '--cpus', '1', '--ipc', 'private',
    '--tmpfs', '/scratch:rw,noexec,nosuid,nodev,size=16777216,mode=700,uid=1000,gid=1000', '--entrypoint', '/usr/bin/env', scratchCompilerImage,
    '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/scratch', 'TMPDIR=/scratch', 'sh', '-c',
    'cc -std=c11 -Wall -Wextra -Werror -O2 -static -fno-pie -no-pie -x c -o /scratch/helper - && base64 -w0 /scratch/helper'],
  { input: source, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const binary = Buffer.from(encoded.toString(), 'base64');
  writeFileSync(path, binary);
  return captureFrozenScratchHelper(path, createHash('sha256').update(binary).digest('hex'));
}
