"""Run with python3 system-keychain.py /absolute/path/to/afk-darwin-arm64.tar.gz."""

import datetime
import hashlib
import hmac
import json
import platform
import re
import secrets
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


SECURITY = '/usr/bin/security'
SOURCE = Path(__file__).resolve().with_name('system-keychain-create.c')
QUERY = {'prompt': 'probe', 'limit': 1, 'scope': 'w10'}
FRAGMENTS = [{'origin': 'w10:private-keychain', 'content': 'accepted'}]


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def preferences():
    state = []
    for operation in ('default-keychain', 'login-keychain', 'list-keychains'):
        result = subprocess.run([SECURITY, operation, '-d', 'user'], capture_output=True, timeout=10)
        require(result.returncode == 0 or (operation == 'login-keychain' and result.returncode == 1
                and not result.stdout and not result.stderr), 'preference metadata unavailable')
        state.append((result.returncode, result.stdout, result.stderr))
    return state


def exercise(root, archive, baseline):
    token = secrets.token_hex(32)
    node = shutil.which('node')
    require(node, 'Node required')
    environment = {'PATH': f'{Path(node).parent}:/usr/bin:/bin', 'HOME': str(root), 'LC_ALL': 'C',
                   'TMPDIR': str(root), 'AFK_EVENT_STORE_DIR': str(root / 'events'),
                   'NODE_EXTRA_CA_CERTS': str(root / 'cert.pem')}

    def run(label, args, data=None, expected=0):
        result = subprocess.run(args, cwd=root, env=environment, capture_output=True,
                                input=data, timeout=35)
        require(token.encode() not in result.stdout + result.stderr, f'{label} output contained credential')
        require(result.returncode == expected, f'{label} exited {result.returncode}')
        return result

    run('extract', ['/usr/bin/tar', '-xzf', archive])
    cli = [node, str(root / 'afk/dist/index.js')]
    version = run('version', [*cli, '--version']).stdout.decode().strip()
    require(re.fullmatch(r'\d+\.\d+\.\d+(?:[-+].+)?', version), 'unexpected CLI version')
    run('compile', ['/usr/bin/clang', '-Wno-deprecated-declarations', SOURCE, '-framework', 'Security',
                    '-framework', 'CoreFoundation', '-o', 'create'])
    run('create private keychain', [root / 'create'])
    require(preferences() == baseline, 'user preference metadata changed during private keychain creation')
    keychain = next((path for path in (root / 'probe.keychain-db', root / 'probe.keychain') if path.is_file()), None)
    require(keychain, 'private keychain file missing')
    service = 'w10-' + secrets.token_hex(12)
    account = 'disposable'
    run('seed', [SECURITY, '-i'],
        f'add-generic-password -s {service} -a {account} -w {token} {keychain}\n'.encode())
    wrapper = root / 'lookup'
    wrapper.write_text(f'''#!/bin/sh
[ "$#" -eq 6 ] && [ "$1" = find-generic-password ] && [ "$2" = -s ] &&
  [ "$3" = {service} ] && [ "$4" = -a ] && [ "$5" = {account} ] && [ "$6" = -w ] || exit 64
printf 'lookup\\n' >> '{root}/lookups' || exit 1
exec {SECURITY} "$@" '{keychain}'
''')
    wrapper.chmod(0o700)
    (root / 'cert.cnf').write_text('[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n'
                                   '[dn]\nCN=W10\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=CA:TRUE\n')
    run('certificate', ['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-keyout', 'key.pem', '-out', 'cert.pem', '-config', 'cert.cnf'])
    observed = []

    class Consumer(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            valid = (self.path == '/search' and json.loads(self.rfile.read(int(self.headers['Content-Length']))) == QUERY
                     and hmac.compare_digest(self.headers.get('Authorization', ''), f'Bearer {token}'))
            observed.append(valid)
            self.send_response(200 if valid else 403)
            self.end_headers()
            self.wfile.write(json.dumps(FRAGMENTS if valid else []).encode())

    def configure(provider, config):
        (root / 'config.json').write_text(json.dumps(config))
        run(provider, [*cli, 'plugin', 'configure', provider, '--builtin', '--file', 'config.json'])

    with HTTPServer(('127.0.0.1', 0), Consumer) as server:
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(root / 'cert.pem', root / 'key.pem')
        server.socket = tls.wrap_socket(server.socket, server_side=True)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            configure('credential.system-keychain', {'service': service, 'command': str(wrapper)})
            configure('context.knowledge-base', {'endpoint': f'https://127.0.0.1:{server.server_port}/search',
                      'token': {'provider': 'credential.system-keychain', 'name': account}})
            (root / 'query.json').write_text(json.dumps(QUERY))
            invoke = [*cli, 'plugin', 'invoke', 'context.provider', 'context.knowledge-base', 'gather',
                      '--input', 'query.json', '--json']
            response = run('gather', invoke)
            require(json.loads(response.stdout) == FRAGMENTS and observed == [True], 'authenticated gather failed')
            run('delete item', [SECURITY, 'delete-generic-password', '-s', service, '-a', account, keychain])
            rejection = run('gather after deletion', invoke, expected=1)
            require(b'Operation credential unavailable' in rejection.stderr and observed == [True],
                    'expected local resolution failure before second request')
            require((root / 'lookups').read_text().splitlines() == ['lookup', 'lookup'], 'unexpected lookup count')
            require(token.encode() not in (root / '.afk/plugins.yml').read_bytes(), 'credential persisted in settings')
        finally:
            server.shutdown()
            worker.join()
    return {'version': version, 'macOS': platform.mac_ver()[0],
            'arch': platform.machine(), 'native_scoped_lookups': 2, 'authenticated_gather': 'pass',
            'after_item_deletion': 'exit 1, Operation credential unavailable',
            'https_requests_before_and_after_deletion': [1, 0], 'credential_absent_from_cli_output_and_settings': True}


def main():
    require(platform.system() == 'Darwin' and platform.machine() == 'arm64', 'requires Apple Silicon macOS')
    archive = Path(sys.argv[1]).resolve(strict=True)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    require(Path(str(archive) + '.sha256').read_text().split() == [digest, archive.name], 'archive digest mismatch')
    baseline = preferences()
    try:
        with tempfile.TemporaryDirectory(dir='/private/tmp', prefix='afk-w10-') as directory:
            result = exercise(Path(directory), archive, baseline)
    finally:
        require(preferences() == baseline, 'user preference metadata changed')
    require(not Path(directory).exists(), 'teardown check failed')
    result.update(archive_sha256=digest, private_directory_removed=True, user_keychain_preferences_unchanged=True,
                  timestamp=datetime.datetime.now(datetime.UTC).isoformat())
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
