"""Run with python3 issue-event.py /path/to/installed/afk /path/to/gitea."""

import hashlib
import hmac
import http.client
import json
import os
import re
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from contextlib import ExitStack
from pathlib import Path


def request(port, method, path, body=None, headers=None):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
    try:
        connection.request(method, path, body, headers or {})
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def wait_for(check):
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.15)
    raise TimeoutError(check.__name__)


def qualify(afk, gitea, root):
    secret = secrets.token_hex(32)
    env = dict(HOME=str(root), TMPDIR=str(root), PATH=os.pathsep.join([str(Path(shutil.which(tool)).parent) for tool in ('node', 'git')] + ['/usr/bin', '/bin']), GIT_CONFIG_NOSYSTEM='1', GIT_TERMINAL_PROMPT='0')
    listener_env = {**env, 'ISSUE_AUTH': secret}
    def run(*args, environment=env):
        return subprocess.check_output(args, env=environment, cwd=root, text=True, timeout=30).strip()

    def configure(name, settings, *args):
        config = root / (name + '.json')
        config.write_text(json.dumps(settings))
        run(afk, 'plugin', 'configure', name, '--builtin', '--file', config, *args)

    version = run(afk, '--version')
    effects = root / 'action.txt'
    configure('verification.test-runner', {'command': [sys.executable, '-c', 'import sys; open(sys.argv[1], "a").write("verified\\n")', str(effects)]})
    configure('trigger.issue-event', {'triggers': [{'id': 'opened-ready', 'kind': 'webhook', 'payload': {'action': 'opened', 'label': 'ready'}, 'input': {'capability': 'verification.provider', 'provider': 'test-runner', 'operation': 'verify', 'input': {'target': str(root)}}}]}, '--action', 'capability.invoke')

    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    database = root / 'gitea.sqlite'
    config = root / 'app.ini'
    config.write_text(f'''RUN_MODE = prod
[server]
HTTP_ADDR = 127.0.0.1
HTTP_PORT = {port}
ROOT_URL = {base}/
DISABLE_SSH = true
OFFLINE_MODE = true
[database]
DB_TYPE = sqlite3
PATH = {database}
[security]
INSTALL_LOCK = true
[webhook]
ALLOWED_HOST_LIST = 127.0.0.1
[actions]
ENABLED = false
''')
    service = [gitea, '--work-path', str(root), '--config', str(config)]
    run(*service, 'migrate')
    admin = run(*service, 'admin', 'user', 'create', '--username', 'qualifier', '--email', 'qa@example.invalid', '--random-password', '--must-change-password=false', '--access-token')
    token = re.search(r'(?i)access token[^\n]*?\b([a-f0-9]{40,})\b', admin).group(1)

    with ExitStack() as stack:
        def start(name, command, environment):
            logfile = root / (name + '.log')
            output = stack.enter_context(logfile.open('w'))
            proc = subprocess.Popen(command, cwd=root, env=environment, stdout=output, stderr=subprocess.STDOUT)
            def stop():
                proc.terminate()
                try:
                    proc.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
            stack.callback(stop)
            return logfile, stop

        def start_listener(name, port):
            log, stop = start(name, [afk, 'plugin', 'listen', '--host', '127.0.0.1', '--port', str(port), '--queue', str(root/'queue.sqlite'), '--token-env', 'ISSUE_AUTH'], listener_env)
            address = wait_for(lambda: re.search(r'listener ready at 127\.0\.0\.1:(\d+)', log.read_text()))
            return int(address.group(1)), stop

        listener_port, stop_listener = start_listener('listener', 0)
        listener = f'http://127.0.0.1:{listener_port}'
        endpoint = '/triggers/trigger.issue-event'
        start('gitea', [*service, 'web'], env)
        def ready():
            try:
                return request(port, 'GET', '/api/v1/version')[0] == 200
            except OSError:
                return False
        wait_for(ready)
        def api(method, path, data=None):
            status, raw = request(port, method, '/api/v1'+path, json.dumps(data) if data is not None else None, {'Authorization': 'token '+token, 'Content-Type': 'application/json'})
            assert 200 <= status < 300, (method, path, status)
            return json.loads(raw) if raw else None

        repo = api('POST', '/user/repos', {'name': 'parcel', 'private': True})
        project = repo['full_name']
        assert project == 'qualifier/parcel'
        route = '/repos/'+project
        label = api('POST', route+'/labels', {'name':'ready', 'color':'#007700'})
        hook = api('POST', route+'/hooks', {'type':'gitea', 'active':True, 'events':['issues'], 'config':{'url':listener+endpoint, 'content_type':'json', 'secret':secret}})
        issue = api('POST', route+'/issues', {'title':'signed issue qualification', 'labels':[label['id']]})
        number = issue['number']
        wait_for(lambda: effects.exists() and effects.read_text().splitlines() == ['verified'])
        api('PATCH', f'{route}/issues/{number}', {'state':'closed'})
        assert api('GET', f'{route}/issues/{number}')['state'] == 'closed'

        def completed_tasks():
            with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as connection:
                connection.row_factory = sqlite3.Row
                rows = connection.execute('SELECT * FROM hook_task WHERE hook_id=? AND is_delivered=1 ORDER BY id', (hook['id'],)).fetchall()
                return rows if len(rows) == 3 else None
        tasks = wait_for(completed_tasks)
        def settled():
            rows = json.loads(run(afk, 'plugin', 'deliveries', '--url', listener, '--token-env', 'ISSUE_AUTH', environment=listener_env))['deliveries']
            return rows if len(rows) == len(tasks) and all(row['status'] == 'delivered' for row in rows) else None
        before_restart = wait_for(settled)
        stop_listener()
        restarted_port, _ = start_listener('restarted-listener', listener_port)
        assert restarted_port == listener_port
        receipts = []
        for row in tasks:
            outgoing = json.loads(row['request_content'])
            incoming = json.loads(row['response_content'])
            assert outgoing['url'] == listener+endpoint and outgoing['http_method'] == 'POST'
            body = outgoing['body'].encode()
            payload = json.loads(body)
            headers = {name.lower(): value for name, value in outgoing['headers'].items()}
            assert 'authorization' not in headers and 'x-gitlab-token' not in headers
            signature = headers['x-hub-signature-256']
            assert hmac.compare_digest(signature, 'sha256='+hmac.new(secret.encode(), body, hashlib.sha256).hexdigest())
            assert payload['repository']['id'] == repo['id'] and payload['repository']['full_name'] == project
            assert payload['issue']['number'] == number and 'ready' in [entry['name'] for entry in payload['issue']['labels']]
            assert incoming['status'] == 202, incoming['status']
            accepted = json.loads(incoming['body'])
            assert accepted['duplicate'] is False
            delivery = headers['x-github-delivery']
            assert delivery == row['uuid']
            replay_headers = {'X-Hub-Signature-256':signature, 'X-GitHub-Delivery':delivery, 'Content-Type':'application/json'}
            assert request(listener_port, 'POST', endpoint, body+b' ', replay_headers)[0] == 401
            status, raw = request(listener_port, 'POST', endpoint, body, replay_headers)
            repeated = json.loads(raw)
            assert status == 202 and repeated['duplicate'] and repeated['deliveryId'] == accepted['deliveryId']
            receipts.append(dict(action=payload['action'], sourceId=delivery, bodySha256=hashlib.sha256(body).hexdigest(), accepted=accepted, replay=repeated, tamperedStatus=401))
        assert sorted(item['action'] for item in receipts) == ['closed', 'label_updated', 'opened']
        deliveries = wait_for(settled)
        assert {row['deliveryId']: row['attempts'] for row in before_restart} == {row['deliveryId']: row['attempts'] for row in deliveries}
        assert {row['deliveryId'] for row in deliveries} == {event['accepted']['deliveryId'] for event in receipts}
        assert all(row['providerId'] == 'trigger.issue-event' and row['attempts'] == 1 for row in deliveries)
        assert effects.read_text().splitlines() == ['verified']
        return dict(afk=version, gitea=run(gitea,'--version'), repository=project, repositoryId=repo['id'], issue=number, label='ready', hookId=hook['id'], events=receipts, deliveries=deliveries, replayAfterListenerRestart=True, actionCount=1)


if __name__ == '__main__':
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix='w10-issue-event.') as temporary:
        result = qualify(*(str(Path(arg).resolve(strict=True)) for arg in sys.argv[1:]), Path(temporary))
        print(json.dumps(result, indent=2))
