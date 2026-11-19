"""Run with python3 pi-local-inference.py /path/to/installed/afk. Prints a redacted JSON receipt."""
import argparse
from contextlib import ExitStack
from datetime import datetime, timezone
from http.client import HTTPConnection
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import signal
import socket
import subprocess
import tempfile
import time


def port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def request(port_number, route, data=None, headers=None):
    connection = HTTPConnection('127.0.0.1', port_number, timeout=135)
    try:
        connection.request('GET' if data is None else 'POST', '/' + route,
                           None if data is None else json.dumps(data), headers or {})
        response = connection.getresponse()
        if response.status != 200:
            raise RuntimeError(f'{route} returned HTTP {response.status}')
        return json.load(response)
    finally:
        connection.close()


def start(stack, command, env, workspace, port_number, health, headers=None):
    child = subprocess.Popen(command, env=env, cwd=workspace, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)

    def stop():
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()

    stack.callback(stop)
    for _ in range(100):
        if child.poll() is not None:
            raise RuntimeError(f'{Path(command[0]).name} exited during startup ({child.returncode})')
        try:
            request(port_number, health, headers=headers)
            return
        except ConnectionRefusedError:
            time.sleep(0.1)
    raise RuntimeError(f'{health} readiness timed out')


def qualify(afk, root, stack):
    cache = Path.home() / '.cache/huggingface/hub/models--Qwen--Qwen3.5-2B'
    model = cache / 'snapshots' / (cache / 'refs/main').read_text().strip()
    if not any(model.glob('*.safetensors')):
        raise RuntimeError('Cached Qwen3.5-2B weights missing')
    pi = shutil.which('pi')
    agent_dir, workspace, bin_dir = root / '.pi/agent', root / 'workspace', root / 'bin'
    for directory in [agent_dir, workspace, bin_dir]:
        directory.mkdir(parents=True)
    env = dict(HOME=str(root), PATH=os.pathsep.join([str(bin_dir), str(Path(shutil.which('node')).parent), os.defpath]),
               PI_CODING_AGENT_DIR=str(agent_dir), PI_OFFLINE='1', GIT_CONFIG_NOSYSTEM='1')

    def run(*command, environment=env):
        return subprocess.run(command, cwd=workspace, env=environment, check=True, capture_output=True,
                              timeout=150, text=True).stdout.strip()

    afk_version, pi_version = run(afk, '--version'), run(pi, '--version')
    run('git', 'init', '-q')
    model_port = port()
    ollama = shutil.which('ollama')
    model_env = dict(env, OLLAMA_NO_CLOUD='1', OLLAMA_HOST=f'127.0.0.1:{model_port}', OLLAMA_MODELS=str(root / 'models'))
    start(stack, [ollama, 'serve'], model_env, workspace, model_port, 'api/version')
    model_name = 'w10-qwen:latest'
    modelfile = root / 'Modelfile'
    modelfile.write_text(f'FROM {model}\nPARAMETER temperature 0\nPARAMETER num_ctx 4096\n')
    run(ollama, 'create', model_name, '-f', modelfile, environment=model_env)
    provider = dict(baseUrl=f'http://127.0.0.1:{model_port}/v1', api='openai-completions', apiKey='local-only',
                    models=[dict(id=model_name, contextWindow=4096, maxTokens=1024)])
    (agent_dir / 'models.json').write_text(json.dumps({'providers': {'qualification': provider}}))
    flags = ['--offline', '--no-tools', '--no-mcp', '--no-extensions', '--no-skills', '--no-context-files',
             '--no-prompt-templates', '--provider', 'qualification', '--model', model_name, '--thinking', 'off']
    launcher = bin_dir / 'pi'
    launcher.write_text('#!/bin/sh\nexec ' + shlex.join([pi, *flags]) + ' "$@"\n')
    launcher.chmod(0o700)

    afk_port = port()
    token = secrets.token_hex(32)
    headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
    start(stack, [afk, 'plugin', 'serve-container', '--repository', str(workspace), '--workspace-root', str(workspace),
                  '--sandbox', 'local', '--agent', 'pi', '--token-env', 'W10_TOKEN', '--port', str(afk_port)],
          dict(env, W10_TOKEN=token), workspace, afk_port, 'health', headers)
    sandbox = request(afk_port, 'sandbox.create', dict(worktreePath=str(workspace), session='pi-local'), headers)['id']
    first, second = secrets.randbelow(9) + 11, secrets.randbelow(9) + 21
    expected = first + second
    prompt = (f'What is {first} + {second}? Replace N with the numeric answer. Reply with only '
              '<goal_complete>{"type":"goal_complete","summary":"N"}</goal_complete>.')
    options = dict(command={'argv': ['pi']}, metadata=dict(provider='pi', transport='process'), generation=0,
                   prompt=prompt, signalType='goal_complete', executionMode='batch')
    execution = request(afk_port, 'agent.start', dict(sandboxId=sandbox, options=options), headers)['id']
    result = request(afk_port, 'agent.wait', dict(sandboxId=sandbox, executionId=execution,
                     options={'completionTimeoutMs': 120000}), headers)
    request(afk_port, 'sandbox.close', dict(sandboxId=sandbox), headers)

    transcript, = (agent_dir / 'sessions').rglob('*.jsonl')
    rows = [json.loads(line) for line in transcript.read_text().splitlines()]
    messages = [row['message'] for row in rows if row['type'] == 'message']
    assistant, = [message for message in messages if message['role'] == 'assistant']
    text = ''.join(part['text'] for part in assistant['content'] if part['type'] == 'text').strip()
    match = re.fullmatch(r'<goal_complete>(.*?)</goal_complete>', text, re.S)
    answer = json.loads(match[1]).get('summary') if match else None
    native = assistant['usage']
    usage = dict(inputTokens=native['input'] + native['cacheRead'] + native['cacheWrite'],
                 outputTokens=native['output'], totalTokens=native['totalTokens'])
    checks = dict(completed=result['status'] == 'completed' and result.get('exitCode') == 0,
                  answer=(result.get('structuredOutput') or {}).get('summary') == answer == str(expected),
                  model=assistant['provider'] == 'qualification' and assistant['model'] == model_name,
                  session=rows[0]['type'] == 'session' and bool(result.get('sessionId')) and
                  rows[0]['id'] == result['sessionId'] and Path(rows[0]['cwd']).resolve() == workspace,
                  stopped=assistant['stopReason'] == 'stop',
                  noTools=[message['role'] for message in messages if message['role'] != 'system'] == ['user', 'assistant'] and
                  all(part['type'] != 'toolCall' for part in assistant['content']),
                  usage=result.get('usage') == usage and min(usage.values()) > 0 and
                  usage['inputTokens'] + usage['outputTokens'] == usage['totalTokens'])
    return dict(passed=all(checks.values()), checkedAt=datetime.now(timezone.utc).isoformat(timespec='seconds'),
                afk=afk_version, pi=pi_version, ollama=request(model_port, 'api/version')['version'],
                entry='plugin serve-container / local / pi', model='Qwen3.5-2B',
                revision=model.name, operands=[first, second], expected=expected,
                answer=answer if isinstance(answer, str) and re.fullmatch(r'\d{1,3}', answer) else None,
                status=result['status'], roles=[message['role'] for message in messages],
                assistantBlocks=[part['type'] for part in assistant['content']],
                nativeUsage=usage, afkUsage=result.get('usage'), checks=checks)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('afk', type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='pi-local-') as temp, ExitStack() as stack:
        receipt = qualify(args.afk.resolve(strict=True), Path(temp).resolve(), stack)
    print(json.dumps(receipt, indent=2))
    raise SystemExit(0 if receipt['passed'] else 1)
