"""Run with a locally built CLI archive and an image containing Dunst, Xvfb, libnotify, dbus and xwininfo."""

import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path


def exercise(profile, archive, image):
    def run(*args, env=None):
        return subprocess.check_output(args, cwd=profile, env=env, text=True, timeout=35).strip()

    endpoint = os.environ.get('DOCKER_HOST') or run('docker', 'context', 'inspect', '-f', '{{.Endpoints.docker.Host}}')
    if not endpoint.startswith('unix://') or not __debug__:
        raise RuntimeError('Use a local Docker socket and enable Python assertions')
    env = {'PATH': os.environ['PATH'], 'HOME': str(profile), 'DOCKER_HOST': endpoint}
    run('bash', Path(__file__).resolve().parents[3] / 'install.sh', '--archive', archive, '--checksum', str(archive) + '.sha256',
        '--prefix', profile / 'bin', '--skip-completion', env=env)
    cli = profile / 'bin/afk'
    target = run('docker', 'run', '--pull=never', '--network=none', '--cap-drop=ALL', '--read-only', '--tmpfs', '/tmp',
                 '-u', '1000:1000', '-d', '-e', 'HOME=/tmp', '-e', 'DISPLAY=:1', '-e', 'DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/bus',
                 image, 'sh', '-ec', 'dbus-daemon --session --address="$DBUS_SESSION_BUS_ADDRESS" --fork; '
                 'exec Xvfb :1 -screen 0 800x600x24 -nolisten tcp -noreset')
    try:
        def desktop(*args):
            return run('docker', 'exec', target, *args)

        for attempt in range(25):
            if desktop('sh', '-c', 'xwininfo -root >/dev/null 2>&1 && dunstctl is-paused 2>/dev/null || true') == 'false':
                break
            time.sleep(0.2)
        else:
            raise RuntimeError('Dunst did not start')
        bridge = profile / 'bin/notify-send'
        bridge.write_text('#!/bin/sh\nexec docker exec "$W10_DESKTOP" /usr/bin/notify-send "$@" 2>"$HOME/notify-error"\n')
        bridge.chmod(0o700)
        env.update(PATH=str(bridge.parent) + os.pathsep + env['PATH'], W10_DESKTOP=target)
        (profile / 'config.json').write_text('{"platform":"linux"}')
        title = 'Desktop qualification ' + uuid.uuid4().hex
        body = 'Notification received on virtual desktop'
        (profile / 'message.json').write_text(json.dumps({'title': title, 'body': body, 'urgency': 'high'}))
        run(cli, 'plugin', 'configure', 'notification.desktop', '--builtin', '--file', 'config.json', env=env)
        def notify(expected_exit=0):
            result = subprocess.run([cli, 'plugin', 'invoke', 'notification.provider', 'notification.desktop', 'notify',
                                     '--input', 'message.json', '--json'], env=env, cwd=profile, timeout=35, text=True, capture_output=True)
            assert result.returncode == expected_exit, (result.stdout, result.stderr, (profile / 'notify-error').read_text())
            return json.loads(result.stdout)
        assert notify() == {'delivered': True, 'channel': 'desktop'}
        assert desktop('dunstctl', 'count', 'displayed') == '1'
        assert 'IsViewable' in desktop('xwininfo', '-name', 'Dunst')
        desktop('dunstctl', 'close')
        assert desktop('dunstctl', 'count', 'history') == '1'
        history = desktop('gdbus', 'call', '--session', '--dest', 'org.freedesktop.Notifications',
                          '--object-path', '/org/freedesktop/Notifications', '--method', 'org.dunstproject.cmd0.NotificationListHistory')
        for field, value in {'summary': title, 'body': body, 'urgency': 'CRITICAL'}.items():
            assert f"'{field}': <'{value}'>" in history
        server_version = desktop('dunst', '--version')
        run('docker', 'stop', '-t', '1', target)
        failed = notify(1)
        assert failed['delivered'] is False and failed['error']
        return {'cli': run(cli, '--version', env=env), 'server': server_version, 'mapped': True,
                'historyMatches': True, 'urgency': 'CRITICAL', 'afterStopDelivered': False}
    finally:
        run('docker', 'rm', '-f', target)


if __name__ == '__main__':
    with tempfile.TemporaryDirectory() as directory:
        print(json.dumps(exercise(Path(directory), Path(sys.argv[1]).resolve(strict=True), sys.argv[2])))
