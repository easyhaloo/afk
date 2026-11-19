import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import ProxyHandler, build_opener


release, jaeger = (Path(arg).resolve(strict=True) for arg in sys.argv[1:])
driver = Path(__file__).resolve().parents[2] / 'e2e/observability-managed-run.mjs'
run_id = str(uuid.uuid4())
with tempfile.TemporaryDirectory(prefix='installed-jaeger-') as directory:
    root = Path(directory)
    with ExitStack() as sockets:
        ports = []
        for _ in range(3):
            listener = sockets.enter_context(socket.socket())
            listener.bind(('127.0.0.1', 0))
            ports.append(f'127.0.0.1:{listener.getsockname()[1]}')
    ingest, query, grpc = ports
    config = {
        'extensions': {'jaeger_storage': {'backends': {'test': {'memory': {'max_traces': 10}}}},
                       'jaeger_query': {'storage': {'traces': 'test'}, 'http': {'endpoint': query}, 'grpc': {'endpoint': grpc}}},
        'receivers': {'otlp': {'protocols': {'http': {'endpoint': ingest}}}},
        'exporters': {'jaeger_storage_exporter': {'trace_storage': 'test'}, 'debug': {}},
        'service': {'extensions': ['jaeger_storage', 'jaeger_query'], 'telemetry': {'metrics': {'level': 'none'}},
                    'pipelines': {'traces': {'receivers': ['otlp'], 'exporters': ['jaeger_storage_exporter']},
                                  'metrics': {'receivers': ['otlp'], 'exporters': ['debug']}}},
    }
    config_file = root / 'jaeger.json'
    config_file.write_text(json.dumps(config))
    env = {'PATH': os.environ['PATH'], 'HOME': directory, 'USERPROFILE': directory, 'WORKSPACE_E2E': directory,
           'AFK_EVENT_STORE_DIR': str(root / 'events'), 'AFK_E2E_RUNTIME_ROOT': str(release / 'node_modules/@afk/runtime/dist')}
    with subprocess.Popen([jaeger, '--config', config_file], env=env, cwd=root) as backend:
        try:
            client = build_opener(ProxyHandler({}))
            def lookup(identifier):
                now = datetime.now(timezone.utc)
                params = urlencode({'query.serviceName': 'installed-query', 'query.searchDepth': 5, 'query.attributes': json.dumps({'run_id': identifier}),
                                    'query.startTimeMin': (now - timedelta(minutes=5)).isoformat(), 'query.startTimeMax': now.isoformat()})
                try:
                    with client.open(f'http://{query}/api/v3/traces?{params}', timeout=2) as response:
                        return json.load(response)['result']['resourceSpans']
                except HTTPError as error:
                    if error.code == 404 and b'No traces found' in error.read():
                        return []
                    raise

            for attempt in range(50):
                if backend.poll() is not None:
                    raise RuntimeError(f'Jaeger exited with {backend.returncode}')
                try:
                    assert not lookup(run_id)
                    break
                except HTTPError:
                    raise
                except URLError:
                    if attempt == 49:
                        raise
                    time.sleep(0.1)
            settings = root / 'settings.json'
            settings.write_text(json.dumps({'endpoint': f'http://{ingest}', 'serviceName': 'installed-query'}))
            subprocess.run(['node', release / 'dist/index.js', 'plugin', 'configure', 'observability.otlp', '--builtin', '--file', settings],
                           env=env, cwd=root, check=True, timeout=30)
            result = subprocess.run(['node', driver, run_id], env=env, cwd=root, check=True, capture_output=True, text=True, timeout=30)
            report = json.loads(next(line.removeprefix('OBSERVABILITY_RESULT=') for line in result.stdout.splitlines()
                                     if line.startswith('OBSERVABILITY_RESULT=')))
            assert report['result']['status'] == 'not_claimed' and report['integrity']['valid']
            for _ in range(50):
                traces = lookup(run_id)
                if traces:
                    break
                time.sleep(0.1)
            assert traces and not lookup(str(uuid.uuid4()))
            def strings(attributes):
                return {entry['key']: entry['value'].get('stringValue') for entry in attributes}

            matching = {span['traceId'] for resource in traces if strings(resource['resource']['attributes']).get('service.name') == 'installed-query'
                        for scope in resource['scopeSpans'] for span in scope['spans']
                        if strings(span['attributes']).items() >= {'run_id': run_id, 'work_item_id': 'github:acme/api#42'}.items()}
            assert len(matching) == 1
            print(json.dumps({'runId': run_id, 'traceId': matching.pop(), 'unknownRunMatches': 0, 'audit': report['integrity']}))
        finally:
            backend.terminate()
            try:
                backend.wait(timeout=5)
            except subprocess.TimeoutExpired:
                backend.kill()
