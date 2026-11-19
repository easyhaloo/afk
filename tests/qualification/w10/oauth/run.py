import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


parser = argparse.ArgumentParser()
parser.add_argument('archive', type=Path)
args = parser.parse_args()
archive = args.archive.resolve(strict=True)
with archive.open('rb') as stream:
    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
if Path(str(archive) + '.sha256').read_text().split() != [digest, archive.name]:
    sys.exit('CLI archive checksum mismatch')

with tempfile.TemporaryDirectory(prefix='w10-oauth-') as temporary:
    root = Path(temporary)
    for name in ('profile', 'workspace'):
        (root / name).mkdir()
    for name in ('package.json', 'package-lock.json', 'qualify.mjs'):
        shutil.copy(Path(__file__).with_name(name), root)
    env = {'HOME': str(root / 'profile'), 'PATH': os.environ['PATH']}

    def run(*command, **options):
        return subprocess.run(command, cwd=root, env=env, check=True, **options)

    run('npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--userconfig=/dev/null',
        '--globalconfig=' + str(root / 'empty.npmrc'), stdout=sys.stderr)
    run('tar', '-xf', archive)
    run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj',
        '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', 'tls.key',
        '-out', 'tls.crt', stderr=subprocess.DEVNULL)
    env['NODE_EXTRA_CA_CERTS'] = str(root / 'tls.crt')
    result = run('node', 'qualify.mjs', digest, stdout=subprocess.PIPE, timeout=90)
    receipt = json.loads(result.stdout)
receipt['cleanup'] = 'temporary CLI profile, TLS files, IdP dependencies and workspace removed'
print(json.dumps(receipt, indent=2))
