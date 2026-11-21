import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';

const node = realpathSync(process.execPath);

export function isolated(directory, args, control) {
  const ancestors = new Set();
  for (const path of [directory, node, '/System/Library', '/usr/lib', '/dev/null']) {
    for (let parent = dirname(path); parent !== '/'; parent = dirname(parent)) ancestors.add(parent);
  }
  const literal = path => `(literal ${JSON.stringify(path)})`;
  const policy = ['(version 1)(deny default)(allow sysctl-read)', `(allow process-exec ${literal(node)})`,
    `(allow file-read-metadata ${[...ancestors].map(literal).join(' ')})`,
    `(allow file-read* ${literal(node)} (literal "/") (literal "/dev/urandom") (literal "/dev/null")`,
    ` (subpath "/System/Library") (subpath "/usr/lib") (subpath ${JSON.stringify(directory)}))`,
    '(allow file-write* (literal "/dev/null"))'].join('\n');
  return new Promise((done, fail) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', policy, node, ...args], {
      cwd: directory, env: { HOME: directory, TMPDIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', controlSent = false;
    let outputBytes = 0;
    let timer, start;
    const guard = setTimeout(() => { child.kill('SIGKILL'); fail(new Error('Diagnostic safety deadline')); }, 10000);
    child.once('spawn', () => {
      start = performance.now();
      if (control) timer = setTimeout(() => { controlSent = child.kill('SIGKILL'); }, control.afterMs);
    });
    const collect = append => text => {
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > 8192) {
        child.kill('SIGKILL');
        fail(new Error('Diagnostic output limit'));
      } else append(text);
    };
    child.stdout.setEncoding('utf8').on('data', collect(text => { stdout += text; }));
    child.stderr.setEncoding('utf8').on('data', collect(text => { stderr += text; }));
    child.once('error', fail);
    child.once('exit', () => clearTimeout(timer));
    child.once('close', (exit, signal) => {
      clearTimeout(guard);
      clearTimeout(timer);
      done({ exit, signal, stdout, stderr, elapsedMs: Math.round(performance.now() - start), ...(control && { controlSent }) });
    });
  });
}
