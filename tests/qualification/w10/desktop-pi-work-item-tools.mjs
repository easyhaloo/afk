import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default function scopedTools(pi) {
  const checkout = realpathSync(process.cwd());
  const primary = process.env.DESKTOP_PI_CHECKOUT;
  if (!primary || ![primary, join(primary,'.worktrees/afk-backlog-1-qa')].includes(checkout) || !existsSync(join(checkout, '.git'))) return;
  const directory = join(checkout, '.afk');
  const artifact = join(checkout, 'answer.txt');
  const empty = { type: 'object', properties: {}, additionalProperties: false };
  const text = value => ({ content: [{ type: 'text', text: value }], details: {} });
  let requestedKind, readTicket = false, readAnswer = false;
  pi.on('before_agent_start', event => {
    requestedKind = /"kind":"(task|ac_verification|qa)"/.exec(event.prompt)?.[1];
    readTicket = readAnswer = false;
    pi.setActiveTools(['read_ticket']);
    if (requestedKind) return { systemPrompt: `You are the ${requestedKind} agent for a local text-file ticket. Use the available tools. Read the assigned ticket, inspect the actual answer, and decide whether it meets the criterion. Use write_signal with kind ${requestedKind} to communicate your own conclusion to AFK. Stop after the signal succeeds.` };
  });
  pi.registerTool({ name: 'write_signal', label: 'Write AFK signal', description: 'Atomically write your completion payload to .afk-signal.json with a current timestamp, then validate it. Choose kind as requested in your prompt. Include your verdict for QA.',
    parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['task','ac_verification','qa'] }, summary: { type: 'string' }, result: { type: 'string', enum: ['PASS','FAIL'] } }, required: ['kind','summary'], additionalProperties: false },
    async execute(_id, payload) {
      if (!requestedKind || payload.kind !== requestedKind) throw Error(`This AFK step requests kind ${requestedKind}`);
      if (!readTicket || !readAnswer) throw Error('Read the ticket and the actual answer before reporting');
      const target = join(checkout, '.afk-signal.json');
      const serialized = JSON.stringify({ ...payload, type: 'goal_complete', timestamp: new Date().toISOString() });
      writeFileSync(target + '.tmp', serialized, { flag: 'wx' });
      renameSync(target + '.tmp', target);
      JSON.parse(readFileSync(target, 'utf8'));
      return text('Wrote completion signal');
    } });
  pi.registerTool({ name: 'read_ticket', label: 'Read ticket', description: 'Read the assigned backlog context and acceptance criteria.', parameters: empty,
    async execute() {
      if (realpathSync(directory) !== directory) throw Error('Invalid context directory');
      const names = readdirSync(directory).filter(name => /^backlog-context(?:-[0-9a-f-]{36})?\.md$/.test(name));
      if (names.length !== 1) throw Error('Ambiguous ticket');
      const target = join(directory, names[0]);
      if (!lstatSync(target).isFile()) throw Error('Invalid ticket');
      const content = readFileSync(target, 'utf8');
      readTicket = true;
      pi.setActiveTools(requestedKind === 'task' && !existsSync(artifact) ? ['create_answer'] : ['read_answer']);
      return text(content);
    } });
  pi.registerTool({ name: 'read_answer', label: 'Read answer', description: 'Read answer.txt from this checkout for verification.', parameters: empty,
    async execute() {
      if (!lstatSync(artifact).isFile()) throw Error('Invalid answer');
      const content = readFileSync(artifact, 'utf8');
      readAnswer = true;
      pi.setActiveTools(['write_signal']);
      return text(content);
    } });
  if (checkout === primary && !existsSync(artifact)) pi.registerTool({ name: 'create_answer', label: 'Create answer', description: 'Create answer.txt with the supplied single line and a final newline.',
    parameters: { type: 'object', properties: { line: { type: 'string' } }, required: ['line'], additionalProperties: false },
    async execute(_id, { line }) {
      if (requestedKind !== 'task' || !readTicket) throw Error('Only the assigned implementation step can create an answer');
      if (!/^[A-Za-z0-9 -]{1,80}$/.test(line)) throw Error('Expected one short line');
      writeFileSync(artifact, line + '\n', { flag: 'wx', mode: 0o600 });
      pi.setActiveTools(['read_answer']);
      return text('Created answer.txt');
    } });
}
