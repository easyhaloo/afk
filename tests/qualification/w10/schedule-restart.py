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


def qualify(afk, root, force, in_flight):
    target = root / 'target'
    effects = root / 'effects.txt'
    allow = root / 'allow-effect'
    closed = root / 'interrupted-action-closed'
    profile = root / 'profile'
    profile.mkdir()
    env = {'PATH': str(Path(shutil.which('node')).parent) + os.pathsep + os.defpath,
           'HOME': str(profile), 'SCHEDULE_KEY': secrets.token_hex(32)}
    interval_ms = 4000

    def cli(*args):
        return subprocess.run([afk, *args], cwd=root, env=env, capture_output=True,
                              text=True, timeout=8, check=True).stdout

    def configure(name, config, *args):
        settings = root / (name + '.json')
        settings.write_text(json.dumps(config))
        cli('plugin', 'configure', name, '--builtin', '--file', settings, *args)

    command = ['/bin/sh', '-c', 'pwd -P >> "$1"', 'sh', str(effects)]
    if in_flight:
        target.mkdir()
        command = ['/bin/sh', '-c', 'if [ ! -f "$2" ]; then read -r ignored; touch "$3"; exit 1; fi; pwd -P >> "$1"',
                   'sh', str(effects), str(allow), str(closed)]
    configure('verification.test-runner', {'command': command})
    configure('trigger.schedule', {'triggers': [{'id': 'restart', 'kind': 'schedule',
        'schedule': str(interval_ms), 'input': {'capability': 'verification.provider', 'provider': 'test-runner',
        'operation': 'verify', 'input': {'target': str(target)}}}]}, '--action', 'capability.invoke')

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
        expected_status = 'processing' if in_flight else 'pending'
        return rows[0] if rows and rows[0]['status'] == expected_status and rows[0]['attempts'] >= 1 else None

    version = cli('--version').strip()
    stop = signal.SIGKILL if force or in_flight else signal.SIGTERM
    with listener('initial', stop) as url:
        competitor = subprocess.run(listen, cwd=root, env=env, capture_output=True, text=True, timeout=8)
        assert competitor.returncode != 0 and 'Trigger queue is already owned' in competitor.stderr
        interrupted = wait_for(lambda: interrupted_attempt(url))
    assert not effects.exists()

    downtime = 2 * interval_ms / 1000
    time.sleep(downtime)
    if in_flight:
        wait_for(closed.exists)
        allow.touch()
    else:
        target.mkdir()
    assert not effects.exists()

    def completed(url, count):
        rows = deliveries(url)
        assert len(rows) <= count, rows
        return rows if len(rows) == count and all(row['status'] == 'delivered' for row in rows.values()) else None

    with listener('restarted') as url:
        recovered = wait_for(lambda: completed(url, 1))[interrupted['deliveryId']]
        assert recovered['receivedAt'] == interrupted['receivedAt'] and recovered['attempts'] > interrupted['attempts']
        assert effects.read_text().splitlines() == [str(target)]
        fresh, = [row for key, row in wait_for(lambda: completed(url, 2)).items() if key != interrupted['deliveryId']]
        assert fresh['attempts'] == 1 and fresh['receivedAt'] - recovered['receivedAt'] >= downtime * 1000
    assert effects.read_text().splitlines() == [str(target)] * 2
    return {'afk': version, 'stopSignal': stop.name, 'intervalMs': interval_ms, 'downtimeMs': int(downtime * 1000),
            'competingListenerRejected': True, 'beforeRestart': interrupted, 'recovered': recovered,
            'firstNewTick': fresh, 'observedSuccessfulActions': 2}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('afk', type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--force', action='store_true')
    mode.add_argument('--in-flight', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix='afk-schedule-restart.') as directory:
        print(json.dumps(qualify(args.afk.resolve(strict=True), Path(directory).resolve(), args.force, args.in_flight), indent=2))
