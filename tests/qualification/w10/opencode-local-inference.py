"""Probe an installed AFK with OpenCode 2.x and an existing loopback Ollama model."""
import argparse
from contextlib import ExitStack
from hashlib import sha256
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import runpy
import secrets
import shlex
import shutil
import subprocess
import tempfile
import threading
import time


helpers = runpy.run_path(str(Path(__file__).with_name('pi-local-inference.py')))
port, request, start = (helpers[key] for key in ('port', 'request', 'start'))


def observe_stream(stack, upstream, prompt, model):
    delta, finished = threading.Event(), threading.Event()

    class Observer(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            body = self.rfile.read(int(self.headers['Content-Length']))
            payload = json.loads(body)
            if self.path != '/v1/chat/completions' or payload.get('model') != model:
                self.send_error(403)
                return
            matched = any(row['role'] == 'user' and prompt in str(row['content']) for row in payload['messages'])
            connection = HTTPConnection('127.0.0.1', upstream, timeout=120)
            try:
                connection.request('POST', self.path, body, {'Content-Type': 'application/json'})
                response = connection.getresponse()
                self.send_response(response.status)
                self.send_header('Content-Type', response.getheader('Content-Type'))
                self.end_headers()
                for line in response:
                    self.wfile.write(line)
                    if not matched or not line.startswith(b'data:'):
                        continue
                    data = line[5:].strip()
                    if data == b'[DONE]':
                        finished.set()
                    else:
                        for choice in json.loads(data).get('choices', []):
                            if choice.get('finish_reason'):
                                finished.set()
                            elif choice.get('delta', {}).get('content'):
                                delta.set()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                connection.close()
                if matched:
                    finished.set()

    server = ThreadingHTTPServer(('127.0.0.1', 0), Observer)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    stack.callback(server.server_close)
    stack.callback(server.shutdown)
    return server.server_port, delta, finished


def probe(root, args, stack):
    workspace, config, bin_dir = root / 'workspace', root / '.config/opencode', root / 'bin'
    for directory in [workspace, config, bin_dir]:
        directory.mkdir(parents=True)
    prompt = ('List the integers from 1 through 2000 in order, one per line. Start immediately.' if args.cancel else
              'What is 17 + 24? Output only one JSON object with keys "type" and "summary". Set type to '
              '"goal_complete" and summary to the sum as a decimal string. No markdown.')
    if args.template:
        prompt = ('Calculate 17 + 24. Fill in NN in this exact response template. Replace NN with just the two '
                  'decimal digits of the sum. No other words inside summary.\n{"type":"goal_complete","summary":"NN"}')
    permission = {'*': 'deny'}
    instruction = 'Answer the question directly. Do not use tools.'
    if args.read:
        (workspace / 'operands.txt').write_text('17 + 24\n')
        permission['read'] = {'*': 'deny', 'operands.txt': 'allow'}
        instruction = 'Read the requested relative path exactly once, then return only the requested JSON.'
        prompt = ('Use the read tool on operands.txt. Add the two integers in the file. Fill NN with the two '
                  'decimal digits of the sum. Return exactly this JSON template with NN replaced, without markdown.\n'
                  '{"type":"goal_complete","summary":"NN"}')
    endpoint = args.port
    if args.cancel:
        endpoint, delta, finished = observe_stream(stack, args.port, prompt, args.model)
    model_id = 'qualification/' + args.model
    (config / 'opencode.json').write_text(json.dumps(dict(enabled_providers=['qualification'],
        provider={'qualification': dict(npm='@ai-sdk/openai-compatible', name='Qualification',
            options={'baseURL': f'http://127.0.0.1:{endpoint}/v1'}, models={args.model: dict(name='Local model',
            limit={'context': 8192, 'output': 1024})})}, model=model_id, small_model=model_id,
        default_agent='qualification', agent={'qualification': dict(mode='primary', prompt=instruction,
        permission=permission, **({'steps': 4} if args.read else {})), 'title': {'disable': True}}, permission=permission, share='disabled', autoupdate=False)))
    binary = shutil.which('opencode')
    launcher = bin_dir / 'opencode'
    launcher.write_text('#!/bin/sh\n' + 'echo $$ > ' + shlex.quote(str(root / 'pid')) + '\nexec ' +
                        shlex.quote(binary) + ' "$@" --standalone --title qualification\n')
    launcher.chmod(0o700)
    env = dict(HOME=str(root), PATH=os.pathsep.join([str(bin_dir), str(Path(shutil.which('node')).parent), os.defpath]),
               AFK_OPENCODE_MODEL=model_id, OPENCODE_DISABLE_MODELS_FETCH='true', OPENCODE_DISABLE_AUTOUPDATE='true',
               HTTP_PROXY='http://127.0.0.1:1', HTTPS_PROXY='http://127.0.0.1:1', NO_PROXY='localhost,127.0.0.1')

    def run(*command):
        return subprocess.check_output(command, env=env, cwd=workspace, text=True, timeout=20).strip()

    run('git', 'init', '-q')
    provenance = dict(afk=run(args.afk, '--version'), opencode=run(binary, '--version'), model=model_id,
                      modelDigest=next(row['digest'] for row in request(args.port, 'api/tags')['models'] if row['name'] == args.model))
    number, token = port(), secrets.token_hex(32)
    headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
    start(stack, [args.afk, 'plugin', 'serve-container', '--repository', str(workspace), '--workspace-root', str(workspace),
          '--sandbox', 'local', '--agent', 'opencode', '--token-env', 'QUAL_TOKEN', '--port', str(number)],
          dict(env, QUAL_TOKEN=token), workspace, number, 'health', headers)
    sandbox = request(number, 'sandbox.create', dict(worktreePath=str(workspace), session='synthetic-probe'), headers)['id']
    options = dict(command=dict(argv=['opencode']), metadata=dict(provider='opencode', transport='process'), generation=0,
                   prompt=prompt, signalType='goal_complete', executionMode='batch')
    execution = request(number, 'agent.start', dict(sandboxId=sandbox, options=options), headers)['id']
    ref = dict(sandboxId=sandbox, executionId=execution)
    checks = {}
    family = observe_private_server(root / 'pid')
    checks['observedCliAndServer'] = len(family) == 2
    if args.cancel:
        checks['liveTextDelta'] = delta.wait(90) and not finished.is_set()
        pid = int((root / 'pid').read_text())
        os.kill(pid, 0)
        checks['interrupt'] = request(number, 'agent.interrupt', dict(**ref, reason='manual'), headers) == {'ok': True}
    result = request(number, 'agent.wait', dict(**ref, options={'completionTimeoutMs': 120000}), headers)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and any(alive(pid) for pid in family):
        time.sleep(0.05)
    checks['familyExitedBeforeClose'] = len(family) == 2 and not any(alive(pid) for pid in family)
    if args.cancel:
        checks['aborted'] = result['status'] == 'aborted' and not result.get('structuredOutput')
        try:
            os.kill(pid, 0)
            checks['cliExited'] = False
        except ProcessLookupError:
            checks['cliExited'] = True
        checks['streamClosed'] = finished.wait(5)
    checks['close'] = request(number, 'sandbox.close', dict(sandboxId=sandbox), headers) == {'ok': True}
    checks['missingAfterClose'] = request(number, 'agent.output', ref, headers, expected_status=404)['error']['code'] == 'SANDBOX_MISSING'
    details = dict(status=result['status'], exitCode=result.get('exitCode'), afkUsage=result.get('usage'), observedPids=family)
    if result.get('error'):
        details['errorCode'] = result['error']['code']
    scenario = 'cancel' if args.cancel else 'batch-read' if args.read else 'batch-template' if args.template else 'batch'
    if not args.cancel:
        session, = json.loads(run(binary, 'session', 'list', '--format', 'json', '--standalone'))
        export = json.loads(run(binary, 'session', 'export', session['id'], '--standalone'))
        checks['session'] = session['id'] == export['info']['id'] == result.get('sessionId') and Path(session['directory']).resolve() == workspace
        details['roles'] = [row['type'] for row in export['messages']]
        roles = details['roles']
        checks['roles'] = len(roles) >= 3 and roles[0] == 'user' and roles[-1] == 'idle' and all(role == 'assistant' for role in roles[1:-1])
        if not checks['roles']:
            return dict(**provenance, **details, scenario=scenario, checks=checks, passed=False)
        user, *assistants, idle = export['messages']
        assistant = assistants[-1]
        details['finishes'] = [message['finish'] for message in assistants]
        checks['prompt'] = user['text'].strip() == prompt
        checks['nativeStop'] = idle['outcome'] == 'succeeded' and assistant['finish'] == 'stop'
        checks['model'] = all(message['model']['id'] == args.model and message['model']['providerID'] == 'qualification' for message in assistants)
        checks['finalContent'] = all(part['type'] in ('reasoning', 'text') for part in assistant['content'])
        tools = [part for message in assistants for part in message['content'] if part['type'] == 'tool']
        details['tools'] = [dict(name=part['name'], status=part['state']['status']) for part in tools]
        if args.read:
            checks['read'] = (len(assistants) == 2 and assistants[0]['finish'] == 'tool-calls' and len(tools) == 1
                              and tools[0]['name'] == 'read' and tools[0]['state']['status'] == 'completed'
                              and tools[0]['state']['input'].get('path') == 'operands.txt'
                              and any('17 + 24' in part.get('text', '') for part in tools[0]['state']['content']))
        else:
            checks['noTools'] = not tools
        answer = ''.join(part['text'] for part in assistant['content'] if part['type'] == 'text')
        details['nativeTextSha256'] = sha256(answer.encode()).hexdigest()
        expected = {'type': 'goal_complete', 'summary': '41'}
        try:
            native_answer = json.loads(answer)
        except ValueError:
            native_answer = None
        summary = native_answer.get('summary') if isinstance(native_answer, dict) else None
        details['nativeAnswerIsObject'] = isinstance(native_answer, dict)
        details['summaryType'] = type(summary).__name__
        details['numericSummary'] = str(summary) if str(summary).isascii() and str(summary).isdigit() and len(str(summary)) <= 4 else None
        checks['answerMatchesNative'] = native_answer is not None and native_answer == result.get('structuredOutput')
        checks['answer'] = result['status'] == 'completed' and result.get('exitCode') == 0 and native_answer == expected
        details['messageUsage'] = [usage_of(message['tokens']) for message in assistants]
        usage = {key: sum(item[key] for item in details['messageUsage']) for key in details['messageUsage'][0]}
        details['nativeUsage'] = usage
        checks['sessionUsage'] = usage == usage_of(export['info']['tokens'])
        checks['usage'] = min(usage.values()) > 0 and usage == result.get('usage')
    return dict(**provenance, **details, scenario=scenario, checks=checks, passed=all(checks.values()))


def usage_of(tokens):
    inputs = tokens['input'] + sum(tokens['cache'].values())
    outputs = tokens['output'] + tokens['reasoning']
    return dict(inputTokens=inputs, outputTokens=outputs, totalTokens=inputs + outputs)


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def observe_private_server(pid_file):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if pid_file.exists() and pid_file.read_text().strip():
            cli = int(pid_file.read_text())
            children = subprocess.run(['pgrep', '-P', str(cli)], capture_output=True, text=True).stdout.split()
            for child in children:
                command = subprocess.run(['ps', '-p', child, '-o', 'args='], capture_output=True, text=True).stdout.split()
                if command[1:] == ['serve', '--stdio', '--port', '0']:
                    return [cli, int(child)]
        time.sleep(0.03)
    return []


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('afk', type=Path)
    parser.add_argument('port', type=int)
    parser.add_argument('model')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--cancel', action='store_true')
    mode.add_argument('--template', action='store_true', help='Use the explicit two-digit answer template')
    mode.add_argument('--read', action='store_true', help='Read one synthetic operands file in a separate assistant step')
    args = parser.parse_args()
    args.afk = args.afk.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix='afk-opencode-') as temp, ExitStack() as stack:
        receipt = probe(Path(temp).resolve(), args, stack)
    print(json.dumps(receipt, indent=2))
    raise SystemExit(0 if receipt['passed'] else 1)
