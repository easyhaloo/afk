"""Qualify the installed report-platform provider against a local Grafana snapshot server."""
import argparse
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit
from uuid import uuid4


IMAGE = 'docker.io/grafana/grafana@sha256:9b7b1d9a1deadbe6fed74416d58db47f8af31b5cee214cfb659f89e6dda3f716'
INSTALLER = Path(__file__).resolve().parents[3] / 'install.sh'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def qualify(args, root, receipt):
    for directory in ('home', 'tmp', 'docker'):
        (root / directory).mkdir()
    env = dict(PATH=os.environ['PATH'], HOME=str(root / 'home'), AFK_HOME=str(root / 'home/.afk'),
               TMPDIR=str(root / 'tmp'), DOCKER_CONFIG=str(root / 'docker'), LC_ALL='C')

    def run(*argv, checked=True):
        result = subprocess.run(argv, cwd=root, env=env, capture_output=True, text=True, timeout=60)
        if checked:
            require(result.returncode == 0, result.stderr.strip() or result.stdout.strip())
        return result

    cli = args.afk.resolve(strict=True)
    if cli.name.endswith('.tar.gz'):
        run('bash', INSTALLER, '--archive', cli, '--checksum', str(cli) + '.sha256',
            '--prefix', root / 'bin', '--skip-completion')
        receipt['archive_sha256'] = hashlib.sha256(cli.read_bytes()).hexdigest()
        cli = root / 'bin/afk'
    receipt['cli'] = run(cli, '--version').stdout.strip()
    require(args.socket.is_socket(), f'Expected local Docker socket at {args.socket}')
    docker = [shutil.which('docker') or 'docker', '-H', 'unix://' + str(args.socket.resolve())]
    image = json.loads(run(*docker, 'image', 'inspect', IMAGE).stdout)[0]
    receipt.update(image=IMAGE, image_id=image['Id'], architecture=image['Architecture'])

    def put(payload, checked=True):
        artifact = dict(name='snapshot.json', mediaType='application/json', bytes=base64.b64encode(payload).decode())
        (root / 'input.json').write_text(json.dumps(artifact))
        return run(cli, 'plugin', 'invoke', 'artifact.provider', 'report-platform', 'put', '--json',
                   '--input', 'input.json', checked=checked)

    def reject(payload, reason):
        result = put(payload, checked=False)
        require(result.returncode == 1 and result.stdout == '' and reason in result.stderr,
                f'Expected rejection {reason!r}, got exit {result.returncode}, {result.stdout!r}, {result.stderr!r}')
        return dict(exit=result.returncode, stdout=result.stdout, stderr=result.stderr.strip())

    class LoopbackRelay(socketserver.BaseRequestHandler):
        def handle(self):
            subprocess.run([*docker, 'exec', '-i', container, 'nc', '127.0.0.1', '3000'],
                           stdin=self.request, stdout=self.request, stderr=subprocess.DEVNULL, env=env, timeout=60)

    with socketserver.ThreadingTCPServer(('127.0.0.1', 0), LoopbackRelay, bind_and_activate=False) as relay:
        relay.server_bind()
        host, port = relay.server_address
        origin = f'http://{host}:{port}'
        (root / 'config.json').write_text(json.dumps({'endpoint': origin + '/api/snapshots'}))
        run(cli, 'plugin', 'configure', 'artifact.report-platform', '--builtin', '--file', 'config.json')
        receipt['closed_port'] = reject(b'{}', 'Provider HTTP transport failed')

        def get(path):
            connection = http.client.HTTPConnection(host, port, timeout=5)
            try:
                connection.request('GET', path, headers={'Connection': 'close'})
                response = connection.getresponse()
                return response.status, response.read()
            finally:
                connection.close()

        def start(mode, command):
            config = root / 'grafana.ini'
            config.write_text(f'[snapshots]\npublic_mode = {mode}\n')
            config.chmod(0o644)
            run(*docker, 'cp', config, container + ':/tmp/qualification.ini')
            run(*docker, command, container)
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                try:
                    status, health = get('/api/health')
                    if status == 200 and json.loads(health)['database'] == 'ok':
                        return json.loads(health)['version']
                except (OSError, http.client.HTTPException):
                    pass
                time.sleep(0.2)
            raise RuntimeError(f'Grafana readiness failed after {command}')

        container = run(*docker, 'create', '--pull=never', '--network', 'none', '-e', 'GF_SERVER_HTTP_ADDR=127.0.0.1',
                        '-e', f'GF_SERVER_ROOT_URL={origin}/', '-e', 'GF_PATHS_CONFIG=/tmp/qualification.ini',
                        '-e', 'GF_SNAPSHOTS_EXTERNAL_ENABLED=false', '-e', 'GF_ANALYTICS_REPORTING_ENABLED=false',
                        '-e', 'GF_ANALYTICS_CHECK_FOR_UPDATES=false', IMAGE).stdout.strip()
        try:
            instance = json.loads(run(*docker, 'inspect', container).stdout)[0]
            require(instance['HostConfig']['NetworkMode'] == 'none' and not instance['HostConfig']['PortBindings'],
                    'Expected an isolated container without published ports')
            volumes = [mount['Name'] for mount in instance['Mounts'] if mount['Type'] == 'volume']
            relay.server_activate()
            listener = threading.Thread(target=relay.serve_forever, daemon=True)
            listener.start()
            try:
                receipt['grafana'] = start('true', 'start')
                report = f'<testsuite tests="1"><testcase name="{uuid4().hex}"/></testsuite>\n'
                dashboard = {'title': 'Synthetic CI report', 'panels': [{'id': 1, 'type': 'text', 'title': 'JUnit',
                             'options': {'mode': 'code', 'content': report}}]}
                payload = json.dumps({'dashboard': dashboard, 'external': False}).encode()
                ref = json.loads(put(payload).stdout)
                path = urlsplit(ref['uri']).path
                match = re.fullmatch(r'/dashboard/snapshot/([A-Za-z0-9_-]+)', path)
                require(match and ref == {'name': 'snapshot.json', 'uri': origin + path}, f'Unexpected ref {ref}')
                status, view = get(path)
                require(status == 200 and b'grafana' in view.lower(), 'Snapshot view failed')
                api_path = '/api/snapshots/' + match[1]
                status, data = get(api_path)
                require(status == 200, f'Snapshot API returned {status}')
                snapshot = json.loads(data)['dashboard']
                stored = snapshot['panels'][0]['options']['content'].encode()
                require(stored == report.encode(), 'JUnit readback differs from upload')
                receipt['readback'] = dict(ref=ref, view_status=200, api_status=status,
                                           input_sha256=hashlib.sha256(report.encode()).hexdigest(),
                                           readback_sha256=hashlib.sha256(stored).hexdigest())
                receipt['invalid_json'] = reject(b'{bad JSON', '(400)')
                start('false', 'restart')
                receipt['denied_write'] = reject(payload, '(401)')
                status, after = get(api_path)
                require(status == 200 and json.loads(after)['dashboard'] == snapshot, 'Post-denial readback failed')
                receipt['post_denial'] = dict(api_status=status, dashboard_unchanged=True)
            finally:
                relay.shutdown()
                listener.join()
        finally:
            run(*docker, 'rm', '-fv', container)
        for kind, identifier in [('container', container), *(('volume', volume) for volume in volumes)]:
            absent = run(*docker, kind, 'inspect', identifier, checked=False)
            require(absent.returncode == 1 and identifier in absent.stderr and re.search('no such|not found', absent.stderr, re.I),
                    f'Could not confirm removal of {kind} {identifier}')
        receipt['cleanup'] = dict(container_removed=container, volumes_removed=volumes, verified=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('afk', type=Path, help='installed AFK executable or local release .tar.gz with adjacent .sha256')
    parser.add_argument('--socket', type=Path, default=Path('/var/run/docker.sock'), help='local Docker Unix socket')
    args = parser.parse_args()
    receipt = {'result': 'FAIL'}
    signal.signal(signal.SIGTERM, signal.default_int_handler)
    try:
        with tempfile.TemporaryDirectory(prefix='w10-grafana-') as directory:
            qualify(args, Path(directory), receipt)
        receipt['result'] = 'PASS'
    except (Exception, KeyboardInterrupt) as error:
        receipt['error'] = str(error) or type(error).__name__
    print(json.dumps(receipt, indent=2))
    return 0 if receipt['result'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
