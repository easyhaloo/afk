import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const role = basename(process.argv[1]);
const args = process.argv.slice(2);
const input = readFileSync(0, 'utf8');
const root = process.env.PLUGIN_MATRIX_OUTPUT;
const { mode = 'success' } = JSON.parse(readFileSync(process.env.PLUGIN_MATRIX_CONTROL, 'utf8'));
appendFileSync(join(root, 'commands.jsonl'), `${JSON.stringify({ role, args, input })}\n`);
if (mode === 'failure') {
  process.stderr.write(`matrix ${role} refused\n`);
  process.exit(7);
}
if (role === 'matrix-keychain') {
  process.stdout.write(mode === 'empty' ? '' : `${process.env.PLUGIN_MATRIX_SECRET}\n`);
} else if (role === 'matrix-backend') {
  if (mode === 'invalid-json') {
    process.stdout.write('not-json');
  } else if (mode === 'invalid-shape') {
    process.stdout.write(JSON.stringify({ commit: '', branch: 'main', dirty: 'false' }));
  } else {
    if (args[0] !== 'snapshot' || args[1] !== '--json') throw new Error('Expected typed snapshot arguments');
    const repository = args[2];
    const git = argv => execFileSync('git', ['-C', repository, ...argv], { encoding: 'utf8' }).trim();
    const snapshot = { commit: git(['rev-parse', args[3] === '--ref' ? args[4] : 'HEAD']), branch: git(['branch', '--show-current']), dirty: Boolean(git(['status', '--porcelain'])) };
    writeFileSync(join(root, 'backend-snapshot.json'), JSON.stringify(snapshot));
    process.stdout.write(JSON.stringify(snapshot));
  }
} else if (role === 'matrix-sendmail') {
  writeFileSync(join(root, 'message.eml'), input);
} else if (['notify-send', 'osascript', 'powershell'].includes(role)) {
  writeFileSync(join(root, 'desktop.json'), JSON.stringify({ role, args, input }));
} else {
  throw new Error(`Unexpected fixture command: ${role}`);
}
