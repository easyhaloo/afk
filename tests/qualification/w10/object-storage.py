"""macOS arm64: python3 qualify.py [release/cli directory]. Each run retains its own evidence."""
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime, timezone


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


release = Path(sys.argv[1] if len(sys.argv) > 1 else Path('release/cli')).resolve()
archive = release / 'afk-darwin-arm64.tar.gz'
expected_archive = Path(str(archive) + '.sha256').read_text().split()[0]
sha = lambda data: hashlib.sha256(data).hexdigest()
require(sha(archive.read_bytes()) == expected_archive, 'Release archive digest mismatch')
root = Path(tempfile.mkdtemp(prefix='w10-storage-'))
print(root, flush=True)
os.chdir(root)
os.umask(0o077)
for directory in ('home', 'objects', 'tmp'):
    Path(directory).mkdir()
env = {'PATH': f'{Path(shutil.which("node")).parent}:/usr/bin:/bin:/usr/sbin',
       'HOME': str(root / 'home'), 'AFK_HOME': str(root / 'home/.afk'), 'TMPDIR': str(root / 'tmp')}
commands = []


def run(*args, checked=True):
    result = subprocess.run(args, env=env, text=True, capture_output=True, timeout=60)
    commands.append(dict(argv=list(map(str, args)), exit=result.returncode, stdout=result.stdout.strip(), stderr=result.stderr.strip()))
    if checked:
        require(result.returncode == 0, str(commands[-1]))
    return result


run('bash', release / 'install.sh', '--archive', archive, '--checksum', str(archive) + '.sha256',
    '--prefix', root / 'bin', '--skip-completion')
afk = root / 'bin/afk'
version = run(afk, '--version').stdout.strip()
httpd = '/usr/sbin/httpd'
apache_version = run(httpd, '-v').stdout.splitlines()[0]
with socket.socket() as reservation:
    reservation.bind(('127.0.0.1', 0))
    port = reservation.getsockname()[1]
endpoint = f'http://127.0.0.1:{port}'
name = 'qualification.bin'
object_file = Path('objects') / name
payload = bytes(range(256)) * 16 + b'\x00\xff\n'
replacement = b'denied replacement'
Path('objects/ready').write_bytes(b'ready')
Path('settings.json').write_text(json.dumps({'endpoint': endpoint}))
run(afk, 'plugin', 'configure', 'artifact.object-storage', '--builtin', '--file', 'settings.json')


def get(path):
    client = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
    try:
        client.request('GET', '/' + path)
        response = client.getresponse()
        return response.status, response.read()
    finally:
        client.close()


@contextmanager
def serving(mode):
    config = Path(mode + '.conf')
    modules = ('mpm_event', 'unixd', 'authz_core', 'log_config', 'dav', 'dav_fs')
    loads = '\n'.join(f'LoadModule {module}_module /usr/libexec/apache2/mod_{module}.so' for module in modules)
    config.write_text(f'''ServerRoot "{root}"
{loads}
Listen 127.0.0.1:{port}
ServerName 127.0.0.1
PidFile httpd.pid
ErrorLog error.log
CustomLog access.log "%a %m %U %>s"
DavLockDB "{root}/davlocks"
DocumentRoot "{root}/objects"
<Directory "{root}/objects">
    Dav On
    <Limit GET>
        Require all granted
    </Limit>
    <Limit PUT>
        Require all {mode}
    </Limit>
    <LimitExcept GET PUT>
        Require all denied
    </LimitExcept>
</Directory>
''')
    run(httpd, '-t', '-f', root / config)
    with Path('startup.log').open('ab') as log:
        server = subprocess.Popen([httpd, '-X', '-f', root / config], env=env, stdout=log, stderr=log)
        try:
            for attempt in range(100):
                require(server.poll() is None, 'Apache exited. See startup.log and error.log')
                try:
                    if get('ready') == (200, b'ready'):
                        break
                except OSError:
                    pass
                time.sleep(0.05)
            else:
                raise RuntimeError('Apache readiness failed')
            yield server.pid
        finally:
            if server.poll() is None:
                server.terminate()
                server.wait(timeout=10)


def put(data, filename, checked):
    Path(filename).write_text(json.dumps({'name': name, 'mediaType': 'application/octet-stream',
                                          'bytes': base64.b64encode(data).decode()}))
    return run(afk, 'plugin', 'invoke', 'artifact.provider', 'object-storage', 'put', '--json', '--input', filename, checked=checked)


with serving('granted') as writer_pid:
    ref = json.loads(put(payload, 'create.json', True).stdout)
    require(ref == {'name': name, 'uri': endpoint + '/' + name}, ref)
disk_digest = sha(object_file.read_bytes())
require(disk_digest == sha(payload), 'Offline file mismatch')
with serving('denied') as reader_pid:
    status, stored = get(name)
    require(status == 200 and stored == payload, 'Restart readback mismatch')
    denied = put(replacement, 'overwrite.json', False)
    require(denied.returncode != 0 and '403' in denied.stderr and not denied.stdout.strip(), str(commands[-1]))
    final_status, final_bytes = get(name)
    require(final_status == 200 and final_bytes == payload, 'Post-denial readback mismatch')
access = Path('access.log').read_text().splitlines()
require([row for row in access if f' /{name} ' in row] == [f'127.0.0.1 {method} /{name} {code}' for method, code in
        [('PUT', 201), ('GET', 200), ('PUT', 403), ('GET', 200)]], access)
receipt = dict(result='PASS', utc=datetime.now(timezone.utc).isoformat(), cli=version, archive_sha256=expected_archive,
               server=apache_version, endpoint=endpoint, server_pids=[writer_pid, reader_pid], object_ref=ref,
               bytes=len(payload), input_sha256=sha(payload), offline_file_sha256=disk_digest,
               restart_get_sha256=sha(stored), rejected_input_sha256=sha(replacement), denied_exit=denied.returncode,
               post_denial_get_sha256=sha(final_bytes), access=access, commands=commands,
               cases={'layer': 'E2E', 'added': 2, 'passed': 2, 'failed': 0, 'skipped': 0})
Path('receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
print('PASS', root / 'receipt.json')
