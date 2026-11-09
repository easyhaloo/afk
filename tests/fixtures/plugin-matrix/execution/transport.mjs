import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const binary = basename(process.argv[1]);
const argv = process.argv.slice(2);
const root = dirname(dirname(process.argv[1]));
appendFileSync(join(root, 'transport.jsonl'), JSON.stringify({ binary, argv }) + '\n');
const json = value => process.stdout.write(JSON.stringify(value));
const run = (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 5000 });
const finish = result => {
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  process.exit(result.status ?? 91);
};

if (['claude', 'codex', 'cursor-agent', 'pi', 'opencode', 'copilot'].includes(binary)) {
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  const effect = { binary, argv, prompt, cwd: process.cwd(), pid: process.pid, simulated: true };
  writeFileSync(join(process.cwd(), 'matrix-agent.json'), JSON.stringify(effect));
  const mode = existsSync(join(root, 'agent-mode')) ? readFileSync(join(root, 'agent-mode'), 'utf8') : 'success';
  if (mode === 'failure') {
    process.stderr.write('simulated agent process failure');
    process.exit(23);
  }
  if (mode === 'hang') await new Promise(() => { setInterval(() => {}, 1000); });
  const result = '<goal_complete>{"type":"goal_complete","kind":"task","summary":"simulated agent output"}</goal_complete>';
  if (binary === 'codex') json({ type: 'item.completed', item: { type: 'agent_message', text: result } });
  else if (binary === 'opencode') json({ type: 'text', part: { text: result } });
  else json({ type: 'result', result });
  process.stdout.write('\n');
} else if (['docker', 'podman'].includes(binary)) {
  const statePath = join(root, `${binary}-container.json`);
  if (argv[0] === 'version') process.stdout.write('matrix-fixture-engine\n');
  else if (argv[0] === 'run') {
    const mounts = [];
    for (let index = 0; index < argv.length; index++) {
      if (argv[index] === '-v') {
        const [host, container] = argv[++index].split(':');
        mounts.push({ host, container });
      }
    }
    writeFileSync(statePath, JSON.stringify({ mounts }));
    process.stdout.write(`matrix-${binary}\n`);
  } else if (argv[0] === 'exec') {
    const { mounts } = JSON.parse(readFileSync(statePath, 'utf8'));
    const translate = value => {
      if (value.startsWith(root)) return value;
      const escaped = mounts.map(mount => mount.container).sort((left, right) => right.length - left.length).map(path => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      return value.replace(new RegExp(escaped.join('|'), 'g'), match => mounts.find(mount => mount.container === match).host);
    };
    const commandIndex = argv.indexOf(`matrix-${binary}`);
    if (commandIndex < 0) throw new Error('Unknown simulated container id');
    const command = argv.slice(commandIndex + 1).map(translate);
    const workdirIndex = argv.indexOf('-w');
    const result = spawnSync(command[0], command.slice(1), {
      cwd: translate(workdirIndex < 0 ? '/workspace' : argv[workdirIndex + 1]),
      encoding: 'utf8', timeout: 5000,
    });
    finish(result);
  } else if (!['kill', 'rm'].includes(argv[0])) {
    throw new Error(`Unsupported simulated container operation: ${argv[0]}`);
  }
} else if (binary === 'ssh') {
  finish(run('/bin/sh', ['-c', argv.at(-1)]));
} else if (binary === 'kubectl' && argv[0] === 'exec') {
  const command = argv.slice(argv.indexOf('--') + 1);
  const result = run(command[0], command.slice(1));
  if (result.status) result.stderr += `\ncommand terminated with exit code ${result.status}\n`;
  finish(result);
} else if (binary === 'aws' && argv[1] === 'send-command') {
  const parameters = JSON.parse(argv[argv.indexOf('--parameters') + 1]);
  const result = run('/bin/sh', ['-c', parameters.commands[0]]);
  writeFileSync(join(root, 'ssm-result.json'), JSON.stringify({
    Status: result.status === 0 ? 'Success' : 'Failed', ResponseCode: result.status ?? 91,
    StandardOutputContent: result.stdout, StandardErrorContent: result.stderr,
  }));
  json({ Command: { CommandId: 'matrix-command' } });
} else if (binary === 'aws' && argv[1] === 'get-command-invocation') {
  process.stdout.write(readFileSync(join(root, 'ssm-result.json')));
} else if (binary === 'jms' && argv[0] === 'ls') {
  process.stdout.write('worker 127.0.0.1 Linux server\n');
} else if (binary === 'jms' && argv[0] === 'exec') {
  finish(run(argv[2], argv.slice(3)));
} else {
  process.stderr.write(`Unsupported simulated transport: ${binary} ${JSON.stringify(argv)}`);
  process.exit(91);
}
