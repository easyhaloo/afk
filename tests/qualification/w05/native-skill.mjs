import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const binary = await realpath(execFileSync('which', ['claude'], { encoding: 'utf8' }).trim());
const home = await realpath(homedir());
const dummy = 'local-dummy-no-real-auth';
const resources = { alpha: 'Inventory fixture ALPHA_5f0129', beta: 'Inventory fixture BETA_7de381' };
const markers = { original: 'ORIGINAL_SKILL_CONTENT_e791a1', proposed: 'PROPOSED_SKILL_CONTENT_7dd82f' };
const hash = value => createHash('sha256').update(value).digest('hex');
const grantDigest = process.argv[2];
if (grantDigest !== undefined) assert.match(grantDigest, /^[a-f0-9]{64}$/);
const frozen = process.argv[3] === '--host-controls';
if (frozen) {
  assert.ok(grantDigest);
  Object.assign(resources, { denied: 'Fixture denied 8bf3', fallback: 'Fixture primary fb27' });
}
const observerDigest = hash(await readFile(new URL(import.meta.url)));
const source = 'claude-seatbelt-loopback-read-v1';
const receipt = { version: execFileSync(binary, ['--version'], { encoding: 'utf8', env: { HOME: '/var/empty', PATH: '/usr/bin:/bin' } }).trim(), binarySha256: hash(await readFile(binary)), cases: [] };
const modes = Object.keys(markers).flatMap(variant => ['alpha', 'beta', 'automatic', 'denied-read', 'recovery'].map(mode => [variant, mode]));
for (const [variant, mode] of modes) {
  if (grantDigest && !(frozen ? mode !== 'automatic' : ['alpha', 'beta'].includes(mode))) continue;
  const explicit = mode !== 'automatic';
  const root = await mkdtemp(join(await realpath(tmpdir()), 'native-skill-'));
  const plugin = join(root, 'plugin');
  const work = join(root, 'work');
  const skill = join(plugin, 'skills', 'proof');
  const input = frozen && mode === 'recovery' ? 'fallback' : frozen && mode === 'denied-read' ? 'denied' : mode === 'beta' ? 'beta' : 'alpha';
  const checkId = `behavior-${['alpha', 'beta', 'denied', 'fallback'].indexOf(input) + 1}`;
  const reference = join(skill, 'references', `${input}.md`);
  const fallback = join(skill, 'references', 'beta.md');
  const resource = resources[mode === 'recovery' ? 'beta' : input];
  const otherResource = resource === resources.alpha ? resources.beta : resources.alpha;
  const otherVariant = variant === 'original' ? 'proposed' : 'original';
  const caseResult = { variant, mode, requests: [] };
  receipt.cases.push(caseResult);
  const server = createServer(async (incoming, outgoing) => {
    try {
      assert.equal(incoming.method, 'POST');
      assert.match(incoming.url, /^\/v1\/messages(?:\?|$)/);
      assert.ok(incoming.headers.authorization === `Bearer ${dummy}` || incoming.headers['x-api-key'] === dummy);
      assert.ok(caseResult.requests.length < (mode === 'recovery' ? 3 : 2));
      const chunks = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        assert.ok(size <= 1024 * 1024);
        chunks.push(chunk);
      }
      const request = JSON.parse(Buffer.concat(chunks).toString());
      const messages = JSON.stringify(request.messages);
      const round = caseResult.requests.length;
      if (grantDigest && round > 0) {
        const blocks = request.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
        const prefix = `Base directory for this skill: ${skill}\n\n`;
        const bodies = blocks.filter(block => block.type === 'text' && block.text.startsWith(prefix));
        const calls = blocks.filter(block => block.type === 'tool_use');
        const results = blocks.filter(block => block.type === 'tool_result');
        assert.equal(bodies.length, 1);
        assert.equal(calls.length, round);
        assert.equal(results.length, round);
        const call = calls[round - 1];
        const result = results[round - 1];
        assert.equal(call.name, 'Read');
        assert.equal(call.id, `toolu_fixture_read_${round}`);
        assert.deepEqual(call.input, { file_path: round === 1 ? reference : fallback });
        assert.equal(result.tool_use_id, call.id);
        const path = relative(skill, call.input.file_path);
        const expandedBodyDigest = hash(bodies[0].text.slice(prefix.length));
        let event;
        if (round === 1 && ['denied-read', 'recovery'].includes(mode)) {
          assert.equal(result.is_error, true);
          assert.match(JSON.stringify(result.content), /permission|denied|not allowed|not permitted|EPERM/i);
          event = { outcome: 'denied', path };
        } else {
          assert.notEqual(result.is_error, true);
          assert.equal(result.content, `1\t${resource}`);
          event = { outcome: 'read', path, digest: hash(result.content.slice(2)) };
          if (round === 1) caseResult.load = { checkId, edition: variant, artifactDigest: caseResult.skillDigest,
            inputDigest: hash(input), expandedBodyDigest, resource: path, resourceDigest: event.digest };
        }
        if (frozen) {
          caseResult.run ??= { checkId, edition: variant, snapshotDigest: caseResult.snapshotDigest, expandedBodyDigest, events: [] };
          assert.equal(caseResult.run.expandedBodyDigest, expandedBodyDigest);
          caseResult.run.events.push(event);
        }
      }
      if (frozen && ['denied-read', 'recovery'].includes(mode)) assert.ok(!messages.includes(resources[input]));
      const toolResult = request.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .find(block => block.type === 'tool_result' && block.tool_use_id === `toolu_fixture_read_${round}`);
      const evidence = { selectedBody: messages.includes(markers[variant]), otherBody: messages.includes(markers[otherVariant]),
        expandedInput: messages.includes(`Read references/${input}.md.`),
        resourceRead: Boolean(toolResult && toolResult.is_error !== true && JSON.stringify(toolResult.content).includes(resource)),
        readDenied: Boolean(toolResult?.is_error === true && /permission|denied|not allowed|not permitted|EPERM/i.test(JSON.stringify(toolResult.content))),
        readError: toolResult?.is_error === true,
        resourceExposed: messages.includes(resource), otherResource: messages.includes(otherResource), tools: request.tools?.map(tool => tool.name).sort() ?? [] };
      caseResult.requests.push(evidence);
      const read = explicit && evidence.selectedBody && evidence.tools.includes('Read') && (round === 0 || (mode === 'recovery' && round === 1 && evidence.readDenied));
      outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, value) => outgoing.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
      send('message_start', { message: { id: `msg_fixture_${caseResult.requests.length}`, type: 'message', role: 'assistant', model: request.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 } } });
      if (read) {
        send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_fixture_read_${round + 1}`, name: 'Read', input: {} } });
        send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: round === 0 ? reference : fallback }) } });
      } else {
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Fixture complete' } });
      }
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: read ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } });
      send('message_stop', {});
      outgoing.end();
    } catch (error) {
      caseResult.serverError = error.code ?? error.name;
      outgoing.destroy();
    }
  });
  try {
    await Promise.all([mkdir(join(skill, 'references'), { recursive: true }), mkdir(join(plugin, '.claude-plugin'), { recursive: true }),
      mkdir(work), mkdir(join(root, 'home')), mkdir(join(root, 'tmp'))]);
    await writeFile(join(plugin, '.claude-plugin', 'plugin.json'), '{"name":"fixture"}');
    const fixture = (name, edition) => `---\nname: ${name}\ndescription: Local fixture\ndisable-model-invocation: true\nuser-invocable: true\n---\n${markers[edition]}\nRead references/$ARGUMENTS.md. If alpha is unavailable, beta is the fallback.\n`;
    const amendment = { branches: ['Read reference'], completion: 'Read complete', parameters: [{ description: 'Reference', name: 'ref', required: true }],
      prohibitedConditions: ['Unauthorized'], proposedChange: markers.proposed, recovery: ['Use fallback'], triggers: ['Manual read'] };
    const content = grantDigest && variant === 'proposed'
      ? `${fixture('proof', 'original')}\n## Candidate amendment (requires human review)\n\n${JSON.stringify(amendment)}\n` : fixture('proof', variant);
    await writeFile(join(skill, 'SKILL.md'), content);
    const alternate = join(plugin, 'skills', 'alternate');
    await mkdir(alternate);
    await writeFile(join(alternate, 'SKILL.md'), fixture('alternate', otherVariant));
    for (const [name, bytes] of Object.entries(resources)) await writeFile(join(skill, 'references', `${name}.md`), bytes);
    caseResult.skillDigest = hash(await readFile(join(skill, 'SKILL.md')));
    const snapshot = async () => hash(JSON.stringify([source, observerDigest, grantDigest, receipt.binarySha256, checkId, variant, hash(input),
      hash(await readFile(join(skill, 'SKILL.md'))), await Promise.all(Object.keys(resources).sort().map(async name => {
        const path = `references/${name}.md`;
        return [path, hash(await readFile(join(skill, path)))];
      }))]));
    if (frozen) caseResult.snapshotDigest = await snapshot();
    caseResult.resourceDigest = hash(resource);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const seatbelt = `(version 1) (allow default) (deny network*) (allow network-outbound (remote ip "localhost:${port}"))
      (deny file-read* (require-all (subpath ${JSON.stringify(home)}) (require-not (literal ${JSON.stringify(binary)}))))
      (deny file-write* (require-all (require-not (subpath ${JSON.stringify(root)})) (require-not (literal "/dev/null"))))
      ${frozen ? `(deny file-write* (subpath ${JSON.stringify(plugin)}) (literal ${JSON.stringify(root)}))` : ''}
      ${grantDigest && mode !== 'recovery' ? `(deny file-read-data (literal ${JSON.stringify(join(skill, 'references', input === 'alpha' ? 'beta.md' : 'alpha.md'))}))` : ''}
      ${['denied-read', 'recovery'].includes(mode) ? `(deny file-read-data (literal ${JSON.stringify(reference)}))` : ''}`;
    const environment = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
      CLAUDE_CONFIG_DIR: join(root, 'home', '.claude'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: dummy,
      DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_RETRIES: '0', API_TIMEOUT_MS: '5000' };
    if (frozen) await run('/usr/bin/sandbox-exec', ['-p', seatbelt, '/bin/sh', '-c',
      'for file do if ( : >> "$file" ) 2>/dev/null; then exit 1; fi; done; : > probe', 'freeze', join(skill, 'SKILL.md'), reference, fallback], { cwd: work, env: environment });
    const allowedReads = grantDigest && mode !== 'recovery' ? [reference] : [reference, fallback];
    const settings = { disableAllHooks: true, enabledPlugins: {}, permissions: { allow: allowedReads.map(path => `Read(${path})`), deny: ['Bash', 'Write', 'Edit'] } };
    const result = await run('/usr/bin/sandbox-exec', ['-p', seatbelt, binary, '--bare', '--restricted', '--print', '--verbose', '--output-format', 'stream-json',
      '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--plugin-dir', plugin,
      '--add-dir', plugin, '--tools', 'Skill,Read', '--permission-mode', 'dontAsk', '--settings', JSON.stringify(settings), '--',
      explicit ? `/fixture:proof ${input}` : 'Local fixture without an explicit command'],
    { cwd: work, env: environment, timeout: 12000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    const entries = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    caseResult.final = entries.filter(entry => entry.type === 'result').map(entry => ({ subtype: entry.subtype, isError: entry.is_error }));
    caseResult.loaded = entries.some(entry => entry.type === 'system' && entry.subtype === 'init'
      && ['fixture:proof', 'fixture:alternate'].every(name => entry.slash_commands?.includes(name)));
    caseResult.completed = caseResult.final.length === 1 && caseResult.final[0].isError === false;
    if (frozen) assert.equal(await snapshot(), caseResult.snapshotDigest);
  } catch (error) {
    caseResult.error = { code: error.code ?? error.name, killed: error.killed ?? false,
      stderrKind: /sandbox-exec/.test(error.stderr ?? '') ? 'seatbelt' : /auth/i.test(error.stderr ?? '') ? 'auth' : 'other' };
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
const expected = { alpha: ['initial', 'read'], beta: ['initial', 'read'], automatic: ['initial'],
  'denied-read': ['initial', 'denied'], recovery: ['initial', 'denied', 'read'] };
for (const entry of receipt.cases) {
  const steps = expected[entry.mode];
  entry.passed = Boolean(entry.completed && entry.loaded && !entry.error && !entry.serverError && entry.requests.length === steps.length
    && entry.requests.every((request, index) => (grantDigest && entry.variant === 'proposed' || !request.otherBody) && !request.otherResource
      && request.selectedBody === (entry.mode !== 'automatic') && request.expandedInput === request.selectedBody
      && JSON.stringify(request.tools) === '["Read"]'
      && request.resourceRead === (steps[index] === 'read') && request.resourceExposed === (steps[index] === 'read')
      && request.readError === (steps[index] === 'denied') && request.readDenied === (steps[index] === 'denied')));
}
receipt.passed = receipt.cases.every(entry => entry.passed);
if (grantDigest && receipt.passed) {
  assert.equal(receipt.binarySha256, hash(await readFile(binary)));
  const normal = receipt.cases.filter(entry => ['alpha', 'beta'].includes(entry.mode));
  assert.ok(normal.every(entry => entry.load));
  receipt.skillObservation = { grantDigest, hostBinaryDigest: receipt.binarySha256, loads: normal.map(entry => entry.load) };
  if (frozen) {
    assert.ok(receipt.cases.every(entry => entry.run));
    receipt.skillObservation.hostTrace = { source, observerDigest, runs: receipt.cases.map(entry => entry.run) };
  }
}
console.log(JSON.stringify(receipt, null, 2));
process.exitCode = receipt.passed ? 0 : 1;
