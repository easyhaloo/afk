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


release, jaeger, *metrics_backend = (Path(arg).resolve(strict=True) for arg in sys.argv[1:])
if len(metrics_backend) > 1:
    raise SystemExit('usage: jaeger-query.py INSTALLATION JAEGER [PROMETHEUS]')
driver = Path(__file__).resolve().parents[2] / 'e2e/observability-managed-run.mjs'
run_id = str(uuid.uuid4())
with tempfile.TemporaryDirectory(prefix='installed-jaeger-') as directory:
    root = Path(directory)
    with ExitStack() as sockets:
        ports = []
        for _ in range(4):
            listener = sockets.enter_context(socket.socket())
            listener.bind(('127.0.0.1', 0))
            ports.append(f'127.0.0.1:{listener.getsockname()[1]}')
    ingest, query, grpc, metrics_address = ports
    config = {
        'extensions': {'jaeger_storage': {'backends': {'test': {'memory': {'max_traces': 10}}}},
                       'jaeger_query': {'storage': {'traces': 'test'}, 'http': {'endpoint': query}, 'grpc': {'endpoint': grpc}}},
        'receivers': {'otlp': {'protocols': {'http': {'endpoint': ingest}}}},
        'exporters': {'jaeger_storage_exporter': {'trace_storage': 'test'}, 'debug': {}},
        'service': {'extensions': ['jaeger_storage', 'jaeger_query'], 'telemetry': {'metrics': {'level': 'none'}},
                    'pipelines': {'traces': {'receivers': ['otlp'], 'exporters': ['jaeger_storage_exporter']},
                                  'metrics': {'receivers': ['otlp'], 'exporters': ['debug']}}},
    }
    env = {'PATH': os.environ['PATH'], 'HOME': directory, 'USERPROFILE': directory, 'WORKSPACE_E2E': directory,
           'AFK_EVENT_STORE_DIR': str(root / 'events'), 'AFK_E2E_RUNTIME_ROOT': str(release / 'node_modules/@afk/runtime/dist')}
    with ExitStack() as services:
        def start(command):
            process = services.enter_context(subprocess.Popen(command, env=env, cwd=root))
            def shutdown():
                process.terminate()
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill()
            services.callback(shutdown)
            return process

        client = build_opener(ProxyHandler({}))
        if metrics_backend:
            metrics_url = f'http://{metrics_address}'
            config['exporters']['otlp_http'] = {'endpoint': metrics_url + '/api/v1/otlp'}
            config['service']['pipelines']['metrics']['exporters'] = ['otlp_http']
            prometheus_config = root / 'prometheus.yml'
            prometheus_config.write_text('global: {}\n')
            prometheus = start([metrics_backend[0], f'--config.file={prometheus_config}', f'--storage.tsdb.path={root}/metrics',
                                f'--web.listen-address={metrics_address}', '--web.enable-otlp-receiver', '--enable-feature=otlp-deltatocumulative'])
            for attempt in range(50):
                if prometheus.poll() is not None:
                    raise RuntimeError(f'Prometheus exited with {prometheus.returncode}')
                try:
                    with client.open(metrics_url + '/-/ready', timeout=2):
                        break
                except URLError:
                    if attempt == 49:
                        raise
                    time.sleep(0.1)
        config_file = root / 'jaeger.json'
        config_file.write_text(json.dumps(config))
        backend = start([jaeger, '--config', config_file])
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
        receipt = {'runId': run_id, 'traceId': matching.pop(), 'unknownRunMatches': 0, 'audit': report['integrity']}
        if metrics_backend:
            def metrics(job):
                params = urlencode({'query': '{job="' + job + '"}'})
                with client.open(metrics_url + '/api/v1/query?' + params, timeout=2) as response:
                    return {(row['metric']['__name__'], row['metric'].get('event_type')): float(row['value'][1])
                            for row in json.load(response)['data']['result']}

            for _ in range(50):
                samples = metrics('installed-query')
                if ('run_event_persistence_ms_count', 'run.finished') in samples:
                    break
                time.sleep(0.1)
            for event in ['run.requested', 'run.finished']:
                assert samples['afk_run_events_total', event] == samples['run_event_persistence_ms_count', event] == 1
                assert samples['run_event_persistence_ms_sum', event] >= 0
            assert not metrics('unknown-service')
            timeline = subprocess.check_output(['node', release / 'dist/index.js', 'observe', 'timeline', run_id, '--root', env['AFK_EVENT_STORE_DIR'], '--json'], env=env, cwd=root, timeout=30)
            for event in json.loads(timeline)['events']:
                if event['data'].get('effectKind') == 'observability.delivery':
                    counts = json.loads(event['data']['summary'])['counts']
                    for signal in ('metrics', 'tracing'):
                        assert counts[signal]['succeeded'] > 0 and not any(counts[signal][key] for key in ('failed', 'timed_out', 'dropped', 'skipped')), counts[signal]
            receipt['metricSamples'] = len(samples)
        print(json.dumps(receipt))
