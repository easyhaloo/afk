"""Run with python3 copilot-local-inference.py INSTALLED_AFK COPILOT. Emits a redacted receipt."""
from contextlib import ExitStack
import json
import os
from pathlib import Path
import runpy
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import time


helpers = runpy.run_path(str(Path(__file__).with_name('pi-local-inference.py')))
port, request, start = (helpers[name] for name in ('port', 'request', 'start'))


def qualify(afk, copilot, root, stack):
    cache = Path.home() / '.cache/huggingface/hub/models--Qwen--Qwen3.5-2B'
    model = cache / 'snapshots' / (cache / 'refs/main').read_text().strip()
    workspace, tools = root / 'workspace', root / 'bin'
    workspace.mkdir()
    tools.mkdir()
    model_port, afk_port = port(), port()
    env = dict(HOME=str(root), PATH=os.pathsep.join([str(tools), str(Path(shutil.which('node')).parent), os.defpath]),
               GIT_CONFIG_NOSYSTEM='1', OLLAMA_HOST=f'127.0.0.1:{model_port}', OLLAMA_NO_CLOUD='1',
               OLLAMA_MODELS=str(root / 'models'), COPILOT_OFFLINE='true', COPILOT_MODEL='w10-qwen:latest',
               COPILOT_PROVIDER_BASE_URL=f'http://127.0.0.1:{model_port}/v1',
               COPILOT_PROVIDER_MAX_PROMPT_TOKENS='32768', COPILOT_PROVIDER_MAX_OUTPUT_TOKENS='2048')

    def run(*command):
        return subprocess.run(command, cwd=workspace, env=env, check=True, capture_output=True,
                              text=True, timeout=180).stdout.strip()

    run('git', 'init', '-q')
    ollama = shutil.which('ollama')
    start(stack, [ollama, 'serve'], env, workspace, model_port, 'api/version')
    modelfile = root / 'Modelfile'
    modelfile.write_text(f'FROM {model}\nPARAMETER temperature 0\nPARAMETER num_ctx 32768\n')
    run(ollama, 'create', env['COPILOT_MODEL'], '-f', modelfile)
    version = run(copilot, '--version').splitlines()[0]
    launcher = tools / 'copilot'
    pidfile = root / 'agent.pid'
    launcher.write_text('#!/bin/sh\necho "$$" > ' + shlex.quote(str(pidfile)) + '\nexec ' +
                        shlex.join([str(copilot), '--available-tools', '--disable-builtin-mcps', '--no-custom-instructions']) + ' "$@"\n')
    launcher.chmod(0o700)
    token = secrets.token_hex(32)
    headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
    start(stack, [afk, 'plugin', 'serve-container', '--repository', str(workspace), '--workspace-root', str(workspace),
                  '--sandbox', 'local', '--agent', 'copilot', '--token-env', 'QUAL_TOKEN', '--port', str(afk_port)],
          dict(env, QUAL_TOKEN=token), workspace, afk_port, 'health', headers)

    def call(operation, **body):
        return request(afk_port, operation, body, headers)

    def launch(label, prompt):
        sandbox = call('sandbox.create', worktreePath=str(workspace), session=label)['id']
        options = dict(command={'argv': ['copilot']}, metadata=dict(provider='copilot', transport='process'),
                       generation=0, prompt=prompt, signalType='goal_complete', executionMode='batch')
        execution = call('agent.start', sandboxId=sandbox, options=options)['id']
        return dict(sandboxId=sandbox, executionId=execution)

    first, second = secrets.randbelow(9) + 11, secrets.randbelow(9) + 21
    prompt = (f'Compute {first} + {second}. Output a single JSON object with keys "type" and "summary". '
              'Set "type" to "goal_complete" and "summary" to the sum as a decimal string. No markdown.')
    reference = launch('copilot-sum', prompt)
    result = call('agent.wait', **reference, options={'completionTimeoutMs': 120000})
    call('sandbox.close', sandboxId=reference['sandboxId'])
    receipt = dict(afk=run(afk, '--version'), copilot=version, ollama=request(model_port, 'api/version')['version'],
                   revision=model.name, model=env['COPILOT_MODEL'], operands=[first, second], status=result['status'],
                   errorCode=(result.get('error') or {}).get('code'))
    transcript, = (root / '.copilot/session-state').glob('*/events.jsonl')
    rows = [json.loads(line) for line in transcript.read_text().splitlines()]
    messages = [row['data'] for row in rows if row['type'] == 'assistant.message']
    native = next(row['data'] for row in rows if row['type'] == 'session.start')
    accounting = next(row['data']['usage'] for row in rows if row['type'] == 'session.usage_record')
    usage = dict(inputTokens=accounting['inputTokens'], outputTokens=accounting['outputTokens'])
    usage['totalTokens'] = sum(usage.values())
    output = result.get('structuredOutput') or {}
    checks = dict(completed=result['status'] == 'completed' and result.get('exitCode') == 0,
                  answer=output.get('summary') == str(first + second) and len(messages) == 1 and
                  json.loads(messages[0]['content'].strip().removeprefix('<goal_complete>').removesuffix('</goal_complete>')) == output,
                  nativeSession=native['sessionId'] == transcript.parent.name == result.get('sessionId') and
                  Path(native['context']['cwd']).resolve() == workspace,
                  local=accounting['isByok'] and accounting['model'] == env['COPILOT_MODEL'] and accounting['cost'] == 0,
                  noToolCalls=all(message['toolRequests'] == [] for message in messages) and
                  not any(row['type'].startswith('tool.execution') for row in rows),
                  usage=min(usage.values()) > 0 and usage == result.get('usage'))
    receipt.update(answer=output.get('summary'), nativeUsage=usage, afkUsage=result.get('usage'), checks=checks)
    reference = launch('copilot-interrupt', 'Write all integers from 1 to 1000 in ascending order, one per line.')
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        if '"type":"assistant.message_delta"' in call('agent.output', **reference)['output']:
            break
        time.sleep(0.05)
    else:
        transcripts = [path for path in transcript.parent.parent.glob('*/events.jsonl') if path != transcript]
        event_types = set()
        for path in transcripts:
            for line in path.read_text().splitlines():
                try:
                    event_types.add(json.loads(line)['type'])
                except json.JSONDecodeError:
                    continue
        closed = call('sandbox.close', sandboxId=reference['sandboxId'])
        receipt.update(cancel=dict(afterTextDelta=False, observationTimeoutSeconds=90,
                                   nativeEventTypes=sorted(event_types), closed=closed == {'ok': True}), passed=False)
        return receipt
    pid = int(pidfile.read_text())
    os.kill(pid, 0)
    ack = call('agent.interrupt', **reference, reason='manual')
    cancelled = call('agent.wait', **reference, options={'completionTimeoutMs': 10000})
    try:
        os.kill(pid, 0)
        exited = False
    except ProcessLookupError:
        exited = True
    closed = call('sandbox.close', sandboxId=reference['sandboxId'])
    receipt['cancel'] = dict(afterTextDelta=True, acknowledged=ack == {'ok': True}, status=cancelled['status'],
                             launcherExitedBeforeClose=exited, closed=closed == {'ok': True})
    receipt['passed'] = all(checks.values()) and ack == closed == {'ok': True} and cancelled['status'] == 'aborted' and exited
    return receipt


if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='copilot-qualification-') as temp, ExitStack() as stack:
        result = qualify(*(Path(arg).resolve(strict=True) for arg in sys.argv[1:]), Path(temp).resolve(), stack)
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result['passed'] else 1)
