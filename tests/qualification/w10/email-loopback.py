"""From the repo root, run pnpm release:cli, then
python3 tests/qualification/w10/email-loopback.py release/cli/afk-PLATFORM-ARCH.tar.gz > receipt.json.

Requires local Docker images node:22-alpine (BusyBox sendmail) and a Python
3.11 image (default afk-sandbox-base:node22, override with SMTP_IMAGE).
"""

import json
import os
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True, timeout=45).strip()


def qualify(archive, profile):
    endpoint = os.getenv('DOCKER_HOST') or docker('context', 'inspect', '-f', '{{.Endpoints.docker.Host}}')
    if not endpoint.startswith('unix://') or not __debug__:
        raise SystemExit('Use a local Docker socket and enable Python assertions')
    archive = Path(archive).resolve(strict=True)
    checksum = Path(str(archive) + '.sha256')
    env = {'HOME': str(profile), 'PATH': os.environ['PATH'], 'DOCKER_HOST': endpoint}
    def run(*args):
        return subprocess.check_output(args, cwd=profile, env=env, text=True, timeout=45).strip()

    run('bash', Path(__file__).resolve().parents[3] / 'install.sh', '--skip-completion',
        '--archive', archive, '--checksum', checksum, '--prefix', profile / 'bin')
    cli = profile / 'bin/afk'
    metadata = json.loads((cli.resolve().parents[1] / 'release.json').read_text())
    sender_image = docker('image', 'inspect', '-f', '{{.Id}}', 'node:22-alpine')
    receiver_image = docker('image', 'inspect', '-f', '{{.Id}}', os.getenv('SMTP_IMAGE', 'afk-sandbox-base:node22'))
    run_id = str(uuid.uuid4())
    subject = 'W10 email ' + run_id
    body = f'Loopback readback {run_id}\r\n.dot\rthird\nlast'
    common = ['--pull=never', '--read-only', '--tmpfs', '/tmp', '--cap-drop=ALL']
    receiver = docker('run', '-d', *common, '--network', 'none', '--cap-add=NET_BIND_SERVICE',
                      '--entrypoint', 'python3', receiver_image, '-u', '-m', 'smtpd', '-n', '-d',
                      '-c', 'DebuggingServer', '127.0.0.1:25')
    try:
        env.update(RECEIVER=receiver, SENDER_IMAGE=sender_image)
        sendmail = docker('run', '--rm', *common, '--network', 'none', sender_image, 'busybox').splitlines()[0]
        bridge = profile / 'bin/sendmail'
        bridge.write_text('#!/bin/sh\nexec docker run --rm --pull=never --read-only --cap-drop=ALL -i '
                          '--network "container:$RECEIVER" --entrypoint /usr/sbin/sendmail "$SENDER_IMAGE" "$@"\n')
        bridge.chmod(0o700)
        (profile / 'config.json').write_text(json.dumps({'from': 'sender@example.test', 'to': 'receiver@example.test',
                                                        'sendmailPath': str(bridge)}))
        (profile / 'message.json').write_text(json.dumps({'title': subject, 'body': body, 'urgency': 'high'}))
        run(cli, 'plugin', 'configure', 'notification.email', '--builtin', '--file', 'config.json')
        receipt = json.loads(run(cli, 'plugin', 'invoke', 'notification.provider', 'notification.email',
                                 'notify', '--input', 'message.json', '--json'))
        assert run(cli, '--version') == metadata['version'] and receipt == {'delivered': True, 'channel': 'email'}, receipt
        logs = subprocess.run(['docker', 'logs', receiver], text=True, capture_output=True, check=True, timeout=45)
        transcript = logs.stdout.splitlines()
        protocol = logs.stderr.splitlines()
        start = '---------- MESSAGE FOLLOWS ----------'
        end = '------------ END MESSAGE ------------'
        assert transcript.count(start) == transcript.count(end) == 1, transcript
        message = transcript[transcript.index(start) + 1:transcript.index(end)]
        headers = ['From: sender@example.test', 'To: receiver@example.test', 'Subject: ' + subject, 'X-Urgency: high']
        lines = ['Loopback readback ' + run_id, '.dot', 'third', 'last']
        wire = [line for line in protocol if line.startswith("Data: b'From: ")]
        expected_wire = '\r\n'.join([*headers, '', lines[0], '..dot', *lines[2:]]).encode()
        assert wire == ['Data: ' + repr(expected_wire)], wire
        expected = [*headers, 'X-Peer: 127.0.0.1', '', *lines]
        assert message == [repr(line.encode()) for line in expected], message
        envelope = [line for line in protocol if line.startswith(('sender:', 'recips:'))]
        assert envelope == ['sender: sender@example.test', "recips: ['receiver@example.test']"], envelope
        return dict(provider='notification.email', observed=datetime.now(timezone.utc).isoformat(),
                    release=metadata, archiveSha256=checksum.read_text().split()[0],
                    senderImage=sender_image, receiverImage=receiver_image,
                    sendmail=sendmail, network='none (shared loopback)', afk=receipt,
                    smtpEnvelope=envelope, smtpReadback=message,
                    smtpData=wire[0])
    finally:
        docker('rm', '-f', receiver)


if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='w10-email-') as directory:
        print(json.dumps(qualify(sys.argv[1], Path(directory)), indent=2))
