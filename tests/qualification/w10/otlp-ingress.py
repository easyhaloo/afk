import json
import os
import secrets
import subprocess
import sys
import tempfile
import time
from collections import Counter
from contextlib import ExitStack
from pathlib import Path
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener


def execute(*args, **options):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, timeout=30, **options).stdout.strip()


def qualify(afk, root):
    driver = Path(__file__).resolve().parents[2] / 'e2e/observability-managed-run.mjs'
    collector_image = 'otel/opentelemetry-collector:0.165.0'
    ingress_image = 'nginx:1.27-alpine'
    token = secrets.token_hex(32)
    marker = secrets.token_hex(8)
    collector_settings = root / 'collector.json'
    collector_settings.write_text(json.dumps({
        'extensions': {'health_check': {'endpoint': '127.0.0.1:13133'}},
        'receivers': {'otlp': {'protocols': {'http': {'endpoint': '127.0.0.1:4318'}}}},
        'exporters': {'debug': {'verbosity': 'detailed', 'sampling_initial': 100}},
        'service': {'extensions': ['health_check'], 'pipelines': {
            signal: {'receivers': ['otlp'], 'exporters': ['debug']} for signal in ('traces', 'metrics')
        }},
    }))
    collector_settings.chmod(0o644)
    ingress_settings = root / 'ingress.conf'
    ingress_settings.write_text(f'''
        log_format qualification '$request_method $uri $status';
        server {{
            listen 8080;
            access_log /dev/stdout qualification;
            location = /ready {{ proxy_pass http://127.0.0.1:13133/; }}
            location ~ ^/v1/(traces|metrics)$ {{
                if ($http_authorization != "Bearer {token}") {{ return 401; }}
                proxy_set_header Authorization "";
                proxy_pass http://127.0.0.1:4318;
            }}
        }}
    ''')
    settings = root / 'settings.json'
    with ExitStack() as services:
        def start(image, source, target, *options):
            container = execute('docker', 'run', '--detach', '--rm', '--pull', 'never',
                                '--mount', f'type=bind,source={source},target={target},readonly',
                                *options, image)
            services.callback(execute, 'docker', 'stop', '--time', '5', container)
            return container

        collector = start(collector_image, collector_settings, '/etc/otelcol/config.yaml',
                          '--publish', '127.0.0.1::8080')
        ingress = start(ingress_image, ingress_settings, '/etc/nginx/conf.d/default.conf',
                        '--network', f'container:{collector}')
        endpoint = 'http://' + execute('docker', 'port', collector, '8080/tcp')
        assert endpoint.startswith('http://127.0.0.1:'), endpoint
        client = build_opener(ProxyHandler({}))
        for attempt in range(40):
            try:
                with client.open(endpoint + '/ready', timeout=2) as response:
                    assert response.status == 200
                break
            except (URLError, ConnectionError, TimeoutError):
                if attempt == 39:
                    raise
                time.sleep(0.1)

        env = {'PATH': os.environ['PATH'], 'HOME': str(root), 'WORKSPACE_E2E': str(root),
               'AFK_EVENT_STORE_DIR': str(root / 'events'),
               'AFK_E2E_RUNTIME_ROOT': str(afk.parent.parent / 'node_modules/@afk/runtime/dist')}

        def run(label, authorization):
            run_id = f'{label}-{marker}'
            service = f'installed-otlp-{run_id}'
            settings.write_text(json.dumps({'endpoint': endpoint, 'serviceName': service, 'timeoutMs': 15_000,
                                            'headers': {'authorization': {'env': 'W10_INGRESS_AUTH'}}}))
            run_env = dict(env, W10_INGRESS_AUTH=f'Bearer {authorization}')
            execute(afk, 'plugin', 'configure', 'observability.otlp', '--builtin', '--file', settings,
                    cwd=root, env=run_env)
            output = execute('node', driver, run_id, cwd=root, env=run_env)
            result = json.loads(next(line.split('=', 1)[1] for line in output.splitlines()
                                     if line.startswith('OBSERVABILITY_RESULT=')))
            assert result['result']['status'] == 'not_claimed' and result['integrity']['valid']
            timeline = json.loads(execute(afk, 'observe', 'timeline', run_id, '--root',
                                          env['AFK_EVENT_STORE_DIR'], '--json', cwd=root, env=run_env))
            assert timeline['integrity']['valid']
            events = {event['id']: event['data']['kind'] for event in timeline['events']}
            deliveries = {}
            for event in timeline['events']:
                if event['data'].get('effectKind') == 'observability.delivery':
                    summary = json.loads(event['data']['summary'])
                    assert summary['sourceEventId'] == event['causationId']
                    deliveries[events[event['causationId']]] = summary['counts']
            assert sorted(deliveries) == ['run.finished', 'run.requested']
            return {'runId': run_id, 'serviceName': service, 'audit': result['integrity'], 'deliveries': deliveries}

        def ingress_requests():
            return Counter(line.removeprefix('POST ') for line in execute('docker', 'logs', ingress).splitlines()
                           if line.startswith('POST /v1/'))

        allowed = run('allowed', token)
        denied = run('denied', secrets.token_hex(32))
        requests = ingress_requests()
        collector_logs = execute('docker', 'logs', collector)
        assert set(requests) == {f'/v1/{signal} {status}' for signal in ('traces', 'metrics') for status in (200, 401)}, requests
        def total(report, signal, count):
            return sum(event[signal][count] for event in report['deliveries'].values())

        for signal, path in (('tracing', 'traces'), ('metrics', 'metrics')):
            accepted = total(allowed, signal, 'succeeded') - total(denied, signal, 'succeeded')
            assert accepted == requests[f'/v1/{path} 200']
            assert total(denied, signal, 'failed') == requests[f'/v1/{path} 401']
            assert total(allowed, signal, 'failed') == 0
            assert not any(total(report, signal, count) for report in (allowed, denied)
                           for count in ('timed_out', 'dropped', 'skipped'))
        signals = [allowed['serviceName'], allowed['runId'], 'github:acme/api#42',
                   'afk.run_events_total', 'run.event_persistence_ms']
        assert all(signal in collector_logs for signal in signals)
        assert denied['runId'] not in collector_logs and denied['serviceName'] not in collector_logs

        execute('docker', 'pause', collector)
        try:
            stalled = run('stalled', token)
            stalled_requests = ingress_requests() - requests
            assert stalled_requests == Counter({'/v1/metrics 499': 2}), stalled_requests
        finally:
            execute('docker', 'unpause', collector)
        for counts in stalled['deliveries'].values():
            assert counts['metrics'] == {'succeeded': 0, 'failed': 0, 'timed_out': 1, 'dropped': 1, 'skipped': 0}, counts
            assert counts['tracing'] == {'succeeded': 1, 'failed': 0, 'timed_out': 0, 'dropped': 2, 'skipped': 0}, counts

        recovered = run('recovered', token)
        recovered_requests = ingress_requests() - requests - stalled_requests
        assert recovered_requests == Counter({'/v1/metrics 200': 4, '/v1/traces 200': 2}), recovered_requests
        for event, counts in recovered['deliveries'].items():
            assert counts == allowed['deliveries'][event], counts
        assert recovered['runId'] in execute('docker', 'logs', collector)
        return {'afk': execute(afk, '--version', cwd=root, env=env), 'ingressRequests': dict(requests),
                'allowed': allowed, 'denied': denied, 'collectorObservations': signals,
                'stalled': stalled, 'stalledIngressRequests': dict(stalled_requests),
                'recovered': recovered, 'recoveredIngressRequests': dict(recovered_requests),
                'images': {image: execute('docker', 'image', 'inspect', '--format', '{{.Os}}/{{.Architecture}} {{.Id}}', image)
                           for image in (collector_image, ingress_image)}}


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('usage: otlp-ingress.py INSTALLED_AFK')
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix='afk-otlp-ingress.') as directory:
        print(json.dumps(qualify(Path(sys.argv[1]).resolve(strict=True), Path(directory).resolve()), indent=2))
