import argparse
import json
import multiprocessing
import os
import re
import secrets
import shutil
import signal
import subprocess
import tempfile
import time
from collections import Counter
from contextlib import ExitStack, contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


def wait_for(probe, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = probe()
        if result:
            return result
        time.sleep(0.1)
    raise AssertionError('Timed out waiting for scheduled delivery or listener')


def serve_http_receiver(effects, requests, port, ready):
    class Receiver(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            delivery_id = self.headers.get('Idempotency-Key', '')
            if self.path != '/deliveries' or not re.fullmatch(r'[a-f0-9]{64}', delivery_id):
                self.send_error(400)
                return
            (effects / delivery_id).mkdir(exist_ok=True)
            with requests.open('a') as journal:
                journal.write(delivery_id + '\n')
            self.send_response(204)
            self.end_headers()

    with HTTPServer(('127.0.0.1', port), Receiver) as server:
        with ready:
            ready.send(server.server_port)
        server.serve_forever()


@contextmanager
def http_receiver(effects, requests, port=0):
    spawn = multiprocessing.get_context('spawn')
    parent, child = spawn.Pipe(duplex=False)
    receiver = spawn.Process(target=serve_http_receiver, args=(effects, requests, port, child))
    with parent, child:
        receiver.start()
        child.close()
        try:
            assert parent.poll(8), 'HTTP receiver did not announce readiness'
            yield parent.recv(), receiver.pid
        finally:
            if receiver.is_alive():
                receiver.kill()
            receiver.join(timeout=8)
            assert receiver.exitcode == -signal.SIGKILL, receiver.exitcode
            receiver.close()


def qualify(afk, root, force, in_flight, after_effect, idempotent, receiver_url=None, restart_receiver=None):
    target = root / 'target'
    effects = root / 'effects.txt'
    allow = root / 'allow-effect'
    closed = root / 'interrupted-action-closed'
    profile = root / 'profile'
    profile.mkdir()
    env = {'PATH': str(Path(shutil.which('node')).parent) + os.pathsep + os.defpath,
           'HOME': str(profile), 'SCHEDULE_KEY': secrets.token_hex(32)}
    interval_ms = 4000
    interrupt_processing = in_flight or after_effect or idempotent

    def cli(*args):
        return subprocess.run([afk, *args], cwd=root, env=env, capture_output=True,
                              text=True, timeout=8, check=True).stdout

    def configure(name, config, *args):
        settings = root / (name + '.json')
        settings.write_text(json.dumps(config))
        cli('plugin', 'configure', name, '--builtin', '--file', settings, *args)

    command = ['/bin/sh', '-c', 'pwd -P >> "$1"', 'sh', str(effects)]
    if in_flight or after_effect:
        target.mkdir()
        effect = 'pwd -P >> "$1"'
        pause = 'read -r ignored; touch "$3"; exit 1'
        interrupted_action = f'{effect}; {pause}' if after_effect else pause
        command = ['/bin/sh', '-c', f'if [ ! -f "$2" ]; then {interrupted_action}; fi; {effect}',
                   'sh', str(effects), str(allow), str(closed)]
    action = 'capability.invoke'
    action_input = {'capability': 'verification.provider', 'provider': 'test-runner',
                    'operation': 'verify', 'input': {'target': str(target)}}
    if idempotent:
        action = 'schedule.verify-idempotent'
        action_input = {}
        extension = root / 'receiver'
        extension.mkdir()
        effects.mkdir()
        sdk = afk.parent.parent / 'node_modules/@afk/runtime/dist/plugin-sdk/index.js'
        assert sdk.is_file(), sdk
        manifest = {'id': 'trigger.schedule-receiver', 'version': '1.0.0', 'apiVersion': 1,
                    'trusted': True, 'provides': ['workflow.action'], 'entry': 'index.js'}
        (extension / 'package.json').write_text(json.dumps({'name': 'schedule-receiver', 'version': '1.0.0', 'type': 'module'}))
        (extension / 'plugin.json').write_text(json.dumps(manifest))
        record_effect = f'''
                    const response = await fetch({json.dumps(receiver_url)}, {{
                        method: 'POST', headers: {{ 'Idempotency-Key': id }}, signal: AbortSignal.timeout(5000)
                    }});
                    if (response.status !== 204) throw new Error(`Receiver returned ${{response.status}}`);
        ''' if receiver_url else f'''
                    try {{ mkdirSync(join({json.dumps(str(effects))}, id)); }}
                    catch (error) {{ if (error.code !== 'EEXIST') throw error; }}
        '''
        (extension / 'index.js').write_text(f'''
            import {{ existsSync, mkdirSync }} from 'node:fs';
            import {{ join }} from 'node:path';
            import {{ currentTriggerDeliveryId }} from {json.dumps(sdk.as_uri())};
            export default {{ manifest: {json.dumps(manifest)}, activate(context) {{
                context.registerSystemAction({json.dumps(action)}, async () => {{
                    const id = currentTriggerDeliveryId();
                    if (!/^[a-f0-9]{{64}}$/.test(id ?? '')) throw new Error('Missing durable delivery ID');
                    {record_effect}
                    if (!existsSync({json.dumps(str(allow))})) await new Promise(() => {{}});
                }});
            }} }};
        ''')
        cli('plugin', 'install', extension)
    else:
        configure('verification.test-runner', {'command': command})
    configure('trigger.schedule', {'triggers': [{'id': 'restart', 'kind': 'schedule',
        'schedule': str(interval_ms), 'input': action_input}]}, '--action', action)

    auth = ['--token-env', 'SCHEDULE_KEY']
    listen = [afk, 'plugin', 'listen', '--port', '0', '--queue', str(root / 'deliveries.sqlite'), *auth]

    @contextmanager
    def listener(name, stop=signal.SIGTERM):
        log = root / (name + '.log')
        with log.open('w') as output:
            proc = subprocess.Popen(listen, cwd=root, env=env, stdout=output, stderr=subprocess.STDOUT)
            try:
                def ready():
                    text = log.read_text()
                    assert proc.poll() is None, text
                    return re.search(r'Plugin listener ready at (127\.0\.0\.1:\d+)', text)

                yield 'http://' + wait_for(ready)[1]
            finally:
                if proc.poll() is None:
                    proc.send_signal(stop)
                try:
                    expected = -signal.SIGKILL if stop == signal.SIGKILL else 0
                    assert proc.wait(timeout=10) == expected, log.read_text()
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                    raise

    def deliveries(url):
        rows = json.loads(cli('plugin', 'deliveries', '--url', url, *auth))['deliveries']
        assert all(row['providerId'] == 'trigger.schedule' for row in rows), rows
        return {row['deliveryId']: row for row in rows}

    def interrupted_attempt(url):
        rows = list(deliveries(url).values())
        assert len(rows) <= 1, rows
        expected_status = 'processing' if interrupt_processing else 'pending'
        return rows[0] if rows and rows[0]['status'] == expected_status and rows[0]['attempts'] >= 1 else None

    def observed_effects():
        if idempotent:
            return sorted(item.name for item in effects.iterdir())
        return effects.read_text().splitlines() if effects.exists() else []

    version = cli('--version').strip()
    stop = signal.SIGKILL if force or interrupt_processing else signal.SIGTERM
    pre_restart_effects = [str(target)] if after_effect else []
    with listener('initial', stop) as url:
        competitor = subprocess.run(listen, cwd=root, env=env, capture_output=True, text=True, timeout=8)
        assert competitor.returncode != 0 and 'Trigger queue is already owned' in competitor.stderr
        interrupted = wait_for(lambda: interrupted_attempt(url))
        if idempotent:
            pre_restart_effects = [interrupted['deliveryId']]
        if after_effect or idempotent:
            wait_for(lambda: observed_effects() == pre_restart_effects)
            assert deliveries(url)[interrupted['deliveryId']]['status'] == 'processing'
    assert observed_effects() == pre_restart_effects
    committed_effect = None
    if restart_receiver:
        committed_effect = (effects / interrupted['deliveryId']).stat()
        restart_receiver(interrupted['deliveryId'])

    downtime = 2 * interval_ms / 1000
    time.sleep(downtime)
    if in_flight or after_effect:
        wait_for(closed.exists)
    if interrupt_processing:
        allow.touch()
    else:
        target.mkdir()
    assert observed_effects() == pre_restart_effects

    def completed(url, count):
        rows = deliveries(url)
        assert len(rows) <= count, rows
        return rows if len(rows) == count and all(row['status'] == 'delivered' for row in rows.values()) else None

    with listener('restarted') as url:
        recovered = wait_for(lambda: completed(url, 1))[interrupted['deliveryId']]
        assert recovered['receivedAt'] == interrupted['receivedAt'] and recovered['attempts'] > interrupted['attempts']
        assert observed_effects() == (pre_restart_effects if idempotent else pre_restart_effects + [str(target)])
        fresh, = [row for key, row in wait_for(lambda: completed(url, 2)).items() if key != interrupted['deliveryId']]
        assert fresh['attempts'] == 1 and fresh['receivedAt'] - recovered['receivedAt'] >= downtime * 1000
    final_effects = observed_effects()
    expected = sorted([recovered['deliveryId'], fresh['deliveryId']]) if idempotent else pre_restart_effects + [str(target)] * 2
    assert final_effects == expected
    if committed_effect is not None:
        replayed_effect = (effects / recovered['deliveryId']).stat()
        assert (committed_effect.st_ino, committed_effect.st_mtime_ns) == (
            replayed_effect.st_ino, replayed_effect.st_mtime_ns)
    return {'afk': version, 'stopSignal': stop.name, 'intervalMs': interval_ms, 'downtimeMs': int(downtime * 1000),
            'competingListenerRejected': True, 'beforeRestart': interrupted, 'recovered': recovered,
            'firstNewTick': fresh, 'observedSuccessfulActions': 2,
            'observedEffectsBeforeRestart': len(pre_restart_effects), 'observedEffectsTotal': len(final_effects),
            **({'receiverPreservedOriginalEffect': True} if committed_effect is not None else {}),
            **({'receiverEffectIds': final_effects} if idempotent else {})}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('afk', type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--force', action='store_true')
    mode.add_argument('--in-flight', action='store_true')
    mode.add_argument('--after-effect', action='store_true')
    mode.add_argument('--idempotent', action='store_true')
    mode.add_argument('--http-receiver', action='store_true')
    mode.add_argument('--http-receiver-restart', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix='afk-schedule-restart.') as directory:
        afk = args.afk.resolve(strict=True)
        root = Path(directory).resolve()
        if args.http_receiver or args.http_receiver_restart:
            effects = root / 'effects.txt'
            requests = root / 'receiver-requests.txt'
            receiver_pids = []
            with ExitStack() as processes:
                port, original_pid = processes.enter_context(http_receiver(effects, requests))
                receiver_pids.append(original_pid)

                def restart_receiver(delivery_id):
                    wait_for(lambda: requests.exists() and requests.read_text().splitlines() == [delivery_id])
                    processes.close()
                    resumed_port, resumed_pid = processes.enter_context(http_receiver(effects, requests, port))
                    assert resumed_port == port and resumed_pid != original_pid
                    receiver_pids.append(resumed_pid)

                url = f'http://127.0.0.1:{port}/deliveries'
                receipt = qualify(afk, root, False, False, False, True, url,
                                  restart_receiver if args.http_receiver_restart else None)
            attempts = Counter(requests.read_text().splitlines())
            assert attempts == {receipt['recovered']['deliveryId']: 2, receipt['firstNewTick']['deliveryId']: 1}, attempts
            receipt.update(receiverTransport='http-loopback', receiverRequests=dict(attempts))
            if args.http_receiver_restart:
                receipt.update(receiverPids=receiver_pids, receiverStopSignal='SIGKILL')
        else:
            receipt = qualify(afk, root, args.force, args.in_flight, args.after_effect, args.idempotent)
        print(json.dumps(receipt, indent=2))
