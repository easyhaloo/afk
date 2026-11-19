import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { businessOutput, decodeReply, transcript } from './checker.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const input = '核对交接单';
const body = `Read only when asked: ${input}.\n`;
const name = 'parcel';
const resource = Buffer.from('document\n');
const path = '/business/handoff.json';
const read = { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: path } };
const content = { type: 'tool_result', tool_use_id: read.id, content: '1\tdocument\n2\t' };
const text = { type: 'text', text: '"observed"' };
const system = { role: 'system', content: [] };
const command = { role: 'user', content: [{ type: 'text', text: `<command-message>verified:parcel</command-message>\n<command-name>/verified:parcel</command-name>\n<command-args>${input}</command-args>\n` },
  { type: 'text', text: `Base directory for this skill: /scratch/plugin/skills/parcel\n\n${body}\n\nARGUMENTS: ${input}` }] };
const payload = messages => structuredClone({ tools: [{ name: 'Read' }], messages });
const first = () => payload([command, system]);
const next = () => payload([command, system, { role: 'assistant', content: [read] }, { role: 'user', content: [content] }]);
const session = () => transcript(name, body, input, resource);
const assistant = block => ({ type: 'assistant', message: { content: [block] } });
const user = () => ({ type: 'user', message: { content: [content] }, tool_use_result: { type: 'text', file: { filePath: path, content: resource.toString() } } });
const done = () => ({ type: 'result', subtype: 'success', result: text.text, is_error: false, permission_denials: [] });

function stream(block) {
  const frame = (type, fields = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
  const tool = block.type === 'tool_use';
  return Buffer.from(frame('message_start', { message: { role: 'assistant', content: [] } })
    + frame('content_block_start', { index: 0, content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' } })
    + frame('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } })
    + frame('content_block_stop', { index: 0 }) + frame('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn' } }) + frame('message_stop'));
}

test('binds native invocation, the complete read round and the final backend text', () => {
  const record = session();
  record.request(first()); record.reply(stream(read)); record.request(next()); record.reply(stream(text));
  assert.deepEqual(record.finish([assistant(read), user(), assistant(text), done()]), { inputDigest: sha(input), answer: text.text,
    calls: [{ tool: 'Read', result: { path, digest: sha(resource) } }] });
});

test('accepts a complete zero-read answer and retains a malformed business answer', () => {
  const record = session();
  const block = { type: 'text', text: 'refuse-before-read' };
  record.request(first()); record.reply(stream(block));
  const result = record.finish([assistant(block), { ...done(), result: block.text }]);
  assert.deepEqual(result.calls, []);
  assert.deepEqual(businessOutput(result.answer), { stdout: block.text, exit: 2, valid: false });
});

for (const [label, mutate] of Object.entries({
  'argument present only inside skill': request => { request.messages[0].content[0].text = request.messages[0].content[0].text.replace(input, 'other'); },
  'body present only in command': request => { request.messages[0].content.reverse(); },
  'wrong edition': request => { request.messages[0].content[1].text += 'more'; },
  'unrelated history': request => { request.messages.push({ role: 'assistant', content: [text] }); },
  'extra tool': request => { request.tools.push({ name: 'other' }); },
})) test(`rejects first request with ${label}`, () => {
  const request = first(); mutate(request); assert.throws(() => session().request(request));
});

for (const [label, mutate] of Object.entries({
  'changed issued call': request => { request.messages[2].content[0].id = 'other'; },
  'changed tool result ID': request => { request.messages[3].content[0].tool_use_id = 'other'; },
  'denied read': request => { request.messages[3].content[0].is_error = true; },
  'wrong data': request => { request.messages[3].content[0].content = 'other'; },
  'changed original input': request => { request.messages[0].content[0].text += 'changed'; },
})) test(`rejects continuation with ${label}`, () => {
  const record = session(); record.request(first()); record.reply(stream(read));
  const request = next(); mutate(request); assert.throws(() => record.request(request));
});

for (const [label, mutate] of Object.entries({
  'absent native read': events => { events.splice(1, 1); },
  'wrong native resource': events => { events[1].tool_use_result.file.content = 'swapped'; },
  'wrong native path': events => { events[1].tool_use_result.file.filePath = '/business/other.json'; },
  'CLI-only answer': events => { events[2].message.content[0].text = events[3].result = 'other'; },
  'CLI result mismatch': events => { events[3].result += 'other'; },
  'permission denial': events => { events[3].permission_denials.push({}); },
})) test(`rejects ${label}`, () => {
  const record = session(); record.request(first()); record.reply(stream(read)); record.request(next()); record.reply(stream(text));
  const events = structuredClone([assistant(read), user(), assistant(text), done()]); mutate(events); assert.throws(() => record.finish(events));
});

test('requires an observed complete backend stream and a single use of each call ID', () => {
  const record = session(); record.request(first()); assert.throws(() => record.finish([assistant(text), done()]));
  assert.throws(() => decodeReply(stream(text).subarray(0, -3)));
  assert.throws(() => decodeReply(Buffer.concat([stream(text), stream(text)])));
  assert.throws(() => decodeReply(stream({ ...read, input: { file_path: '/business/other.json' } })));
  record.reply(stream(read)); assert.throws(() => record.finish([assistant(read), user(), done()]));
  record.request(next()); assert.throws(() => record.reply(stream(read)));
});

test('separates supported JSON results from measured business format failures', () => {
  for (const answer of ['', 'not JSON', 'null', 'true', '[]', '1']) assert.deepEqual(businessOutput(answer), { stdout: answer, exit: 2, valid: false });
  assert.deepEqual(businessOutput('"refuse-before-read"'), { stdout: 'refuse-before-read', exit: 1, valid: true });
  assert.deepEqual(businessOutput('"request-missing-page"'), { stdout: 'request-missing-page', exit: 0, valid: true });
  assert.deepEqual(businessOutput('{ "missing": [] }'), { stdout: '{"missing":[]}', exit: 0, valid: true });
});
