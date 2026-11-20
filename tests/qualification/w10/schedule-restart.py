import argparse
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path


def wait_for(probe, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = probe()
        if result:
            return result
        time.sleep(0.1)
    raise AssertionError('Timed out waiting for scheduled delivery or listener')


def qualify(afk, root, force, in_flight, after_effect, idempotent):
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
        (extension / 'index.js').write_text(f'''
            import {{ existsSync, mkdirSync }} from 'node:fs';
            import {{ join }} from 'node:path';
            import {{ currentTriggerDeliveryId }} from {json.dumps(sdk.as_uri())};
            export default {{ manifest: {json.dumps(manifest)}, activate(context) {{
                context.registerSystemAction({json.dumps(action)}, async () => {{
                    const id = currentTriggerDeliveryId();
                    if (!/^[a-f0-9]{{64}}$/.test(id ?? '')) throw new Error('Missing durable delivery ID');
                    try {{ mkdirSync(join({json.dumps(str(effects))}, id)); }}
                    catch (error) {{ if (error.code !== 'EEXIST') throw error; }}
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
    return {'afk': version, 'stopSignal': stop.name, 'intervalMs': interval_ms, 'downtimeMs': int(downtime * 1000),
            'competingListenerRejected': True, 'beforeRestart': interrupted, 'recovered': recovered,
            'firstNewTick': fresh, 'observedSuccessfulActions': 2,
            'observedEffectsBeforeRestart': len(pre_restart_effects), 'observedEffectsTotal': len(final_effects),
            **({'receiverEffectIds': final_effects} if idempotent else {})}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('afk', type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--force', action='store_true')
    mode.add_argument('--in-flight', action='store_true')
    mode.add_argument('--after-effect', action='store_true')
    mode.add_argument('--idempotent', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix='afk-schedule-restart.') as directory:
        print(json.dumps(qualify(args.afk.resolve(strict=True), Path(directory).resolve(), args.force, args.in_flight,
                                 args.after_effect, args.idempotent), indent=2))
