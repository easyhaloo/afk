import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const business = '/business/handoff.json';
const backend = '/opt/afk/model/messages';
const run = promisify(execFile);

export function decodeReply(bytes) {
  const stream = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replaceAll('\r\n', '\n');
  assert.ok(stream.endsWith('\n\n'));
  const events = stream.slice(0, -2).split('\n\n').map(frame => {
    const lines = /^event: ([a-z_]+)\ndata: ([^\n]+)$/.exec(frame);
    assert.ok(lines);
    const event = JSON.parse(lines[2]);
    assert.equal(event.type, lines[1]);
    return event;
  }).filter(event => event.type !== 'ping');
  let index = 0;
  function take(type) {
    const event = events[index++];
    assert.equal(event?.type, type);
    return event;
  }
  const { message } = take('message_start');
  assert.equal(message.role, 'assistant');
  assert.deepEqual(message.content, []);
  const blocks = [];
  while (events[index]?.type === 'content_block_start') {
    const start = take('content_block_start');
    const block = start.content_block;
    assert.equal(start.index, blocks.length);
    const text = block.type === 'text';
    if (text) assert.equal(typeof block.text, 'string');
    else {
      assert.equal(block.type, 'tool_use');
      assert.ok(typeof block.id === 'string' && block.id.length > 0 && block.name === 'Read');
      assert.deepEqual(block.input, {});
    }
    let value = text ? block.text : '';
    while (events[index]?.type === 'content_block_delta') {
      const { index: position, delta } = take('content_block_delta');
      assert.equal(position, blocks.length);
      assert.equal(delta.type, text ? 'text_delta' : 'input_json_delta');
      const part = text ? delta.text : delta.partial_json;
      assert.equal(typeof part, 'string');
      value += part;
    }
    assert.equal(take('content_block_stop').index, blocks.length);
    if (text) blocks.push({ type: 'text', text: value });
    else {
      const input = JSON.parse(value);
      assert.deepEqual(input, { file_path: business });
      blocks.push({ type: 'tool_use', id: block.id, name: block.name, input });
    }
  }
  const tools = blocks.filter(block => block.type === 'tool_use');
  assert.ok(blocks.length && tools.length <= 1);
  assert.equal(take('message_delta').delta.stop_reason, tools.length ? 'tool_use' : 'end_turn');
  take('message_stop');
  assert.equal(index, events.length);
  return blocks;
}

export function transcript(name, body, input, resource) {
  const command = `<command-message>verified:${name}</command-message>\n<command-name>/verified:${name}</command-name>\n<command-args>`;
  const suffix = '</command-args>\n';
  const numbered = resource.toString('utf8').split('\n').map((line, index) => `${index + 1}\t${line}`).join('\n');
  const history = [], native = [], calls = [], ids = new Set();
  let observedInput, answer;
  return {
    request(payload) {
      assert.equal(answer, undefined);
      assert.deepEqual(payload.tools.map(tool => tool.name), ['Read']);
      const messages = payload.messages.map(({ role, content }) => ({ role, content: content.map(({ cache_control, ...block }) => block) }));
      if (!history.length) {
        const marker = messages[0]?.content[0]?.text;
        assert.ok(marker?.startsWith(command) && marker.endsWith(suffix));
        observedInput = marker.slice(command.length, -suffix.length);
        assert.equal(observedInput, input);
        history.push({ role: 'user', content: [{ type: 'text', text: marker }, { type: 'text',
          text: `Base directory for this skill: /scratch/plugin/skills/${name}\n\n${body}\n\nARGUMENTS: ${observedInput}` }] });
        if (messages[1]?.role === 'system') history.push({ role: 'system', content: [] });
      }
      assert.deepEqual(messages, history);
    },
    reply(bytes) {
      const blocks = decodeReply(bytes);
      history.push({ role: 'assistant', content: blocks });
      for (const block of blocks) native.push({ role: 'assistant', block });
      const tool = blocks.find(block => block.type === 'tool_use');
      if (!tool) {
        answer = blocks.map(block => block.text).join('');
        return;
      }
      assert.ok(!ids.has(tool.id) && ids.size < 16);
      ids.add(tool.id);
      const block = { type: 'tool_result', tool_use_id: tool.id, content: numbered };
      history.push({ role: 'user', content: [block] });
      native.push({ role: 'user', block });
      calls.push({ tool: 'Read', result: { path: business, digest: sha(resource) } });
    },
    finish(events) {
      assert.ok(observedInput !== undefined && answer !== undefined);
      const observed = [];
      for (const event of events) {
        if (event.type !== 'assistant' && event.type !== 'user') continue;
        for (const block of event.message.content) {
          if (event.type === 'user') {
            const result = event.tool_use_result;
            assert.ok(result?.type === 'text' && result.file.filePath === business && result.file.content === resource.toString('utf8'));
          }
          observed.push({ role: event.type, block });
        }
      }
      assert.deepEqual(observed, native);
      const results = events.filter(event => event.type === 'result');
      assert.ok(results.length === 1 && results[0] === events.at(-1) && results[0].subtype === 'success' && results[0].is_error === false);
      assert.deepEqual(results[0].permission_denials, []);
      assert.equal(results[0].result, answer);
      return { answer, calls, inputDigest: sha(observedInput) };
    },
  };
}

export function businessOutput(answer) {
  let result;
  try { result = JSON.parse(answer); } catch { result = null; }
  if (typeof result === 'string') return { stdout: result, exit: result === 'refuse-before-read' ? 1 : 0, valid: true };
  if (result && typeof result === 'object' && !Array.isArray(result)) return { stdout: JSON.stringify(result), exit: 0, valid: true };
  return { stdout: answer, exit: 2, valid: false };
}

async function main(artifact, input) {
  const source = readFileSync(artifact);
  const markdown = new TextDecoder('utf-8', { fatal: true }).decode(source);
  const match = /^---\n([^]*?)\n---\n([^]*)$/.exec(markdown);
  assert.ok(match && match[2].trim() && !/[!`]|\$\{|\$ARGUMENTS/.test(markdown), 'Unsupported executable or templated skill');
  const name = basename(dirname(artifact));
  assert.match(name, /^[a-z][a-z0-9-]*$/);
  const fields = match[1].split('\n');
  assert.ok(fields.every(line => /^(name|description|allowed-tools|disallowed-tools|recall-scope|afk-recall|user-invocable|disable-model-invocation): [^\n]+$/.test(line)));
  assert.ok(fields.includes(`name: ${name}`) && fields.includes('allowed-tools: [Read]') && !fields.includes('user-invocable: false'));
  const directory = `/scratch/plugin/skills/${name}`;
  mkdirSync(directory, { recursive: true });
  mkdirSync('/scratch/plugin/.claude-plugin');
  writeFileSync('/scratch/plugin/.claude-plugin/plugin.json', '{"name":"verified"}');
  copyFileSync(artifact, join(directory, 'SKILL.md'));
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/scratch', TMPDIR: '/scratch', CLAUDE_CONFIG_DIR: '/scratch/.claude',
    DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_RETRIES: '0' };
  const session = transcript(name, match[2], input, readFileSync(business));
  let failed = false, busy = false, requests = 0;
  const proxy = createServer(async (request, response) => {
    if (!/^\/v1\/messages(?:\?|$)/.test(request.url)) { response.writeHead(404).end(); return; }
    if (busy) { failed = true; response.destroy(); return; }
    busy = true;
    try {
      assert.ok(!failed && request.method === 'POST' && ++requests <= 17);
      const chunks = [];
      let size = 0;
      for await (const chunk of request) { assert.ok((size += chunk.length) <= 1024 * 1024); chunks.push(chunk); }
      const bytes = Buffer.concat(chunks);
      session.request(JSON.parse(bytes));
      const inference = run(backend, [], { cwd: '/scratch', env, encoding: 'buffer', maxBuffer: 256 * 1024 });
      inference.child.stdin.on('error', () => {});
      inference.child.stdin.end(bytes);
      const { stdout } = await inference;
      session.reply(stdout);
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(stdout);
    } catch { failed = true; response.destroy(); }
    finally { busy = false; }
  });
  try {
    assert.equal(realpathSync(backend), backend);
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const settings = { disableAllHooks: true, enabledPlugins: {}, permissions: { allow: ['Read(//business/handoff.json)'] } };
    const { stdout } = await run('/usr/local/bin/claude', ['--bare', '--restricted', '--print', '--verbose', '--output-format', 'stream-json',
      '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--plugin-dir', '/scratch/plugin',
      '--tools', 'Read', '--permission-mode', 'dontAsk', '--settings', JSON.stringify(settings), '--append-system-prompt',
      'Return only the business result as JSON: an object for a reconciliation or a string for a refusal or information request.',
      '--', `/verified:${name} ${input}`], { cwd: '/business', env: { ...env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.address().port}`,
        ANTHROPIC_API_KEY: 'isolated-loopback' }, maxBuffer: 1024 * 1024 });
    assert.ok(!failed && !busy);
    const { answer, calls, inputDigest } = session.finish(stdout.trim().split('\n').map(line => JSON.parse(line)));
    const businessResult = businessOutput(answer);
    process.stdout.write(businessResult.stdout);
    writeFileSync(3, JSON.stringify({ protocol: 'skill-trace-v1', completed: true, inputDigest, loaded: { path: artifact, digest: sha(source) },
      outputDigest: sha(businessResult.stdout), businessValid: businessResult.valid, calls }));
    process.exitCode = businessResult.exit;
  } finally { proxy.closeAllConnections(); proxy.close(); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main(...process.argv.slice(2));
