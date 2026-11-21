import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlsplit
from urllib.request import urlopen

import boto3
from botocore.config import Config


UPLOAD = '''
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { ObjectStorageProvider } = await import(pathToFileURL(process.argv[1]));
const { uploadUrl, contents, name, expectedStatus } = JSON.parse(readFileSync(0, 'utf8'));
let observed;
const provider = new ObjectStorageProvider({
  resolveUrl: () => uploadUrl,
  transport: async (target, request) => {
    const response = await fetch(target, request);
    observed = { status: response.status };
    if (!response.ok) {
      const body = await response.clone().text();
      observed.code = body.match(/<Code>([^<]+)<\\/Code>/)?.[1];
      observed.expired = body.includes('Request has expired');
    }
    return response;
  },
});
const upload = provider.put({ name, mediaType: 'application/octet-stream', bytes: Buffer.from(contents, 'hex') });
if (expectedStatus === 200) {
  const reference = await upload;
  const target = new URL(uploadUrl);
  assert.deepEqual(reference, { name, uri: target.origin + target.pathname });
  observed.referenceQueryRemoved = true;
} else {
  await assert.rejects(upload, { message: 'Provider HTTP request failed (403)' });
  assert.deepEqual(observed, { status: 403, code: 'AccessDenied', expired: true });
}
assert.equal(observed.status, expectedStatus);
console.log(JSON.stringify(observed));
'''


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def put(runtime, upload_url, name, contents, expected_status):
    data = dict(uploadUrl=upload_url, name=name, contents=contents.hex(), expectedStatus=expected_status)
    result = subprocess.run(['node', '--input-type=module', '-e', UPLOAD, str(runtime)], input=json.dumps(data),
                            capture_output=True, text=True, timeout=20)
    if result.returncode != 0:
        raise RuntimeError(f'ObjectStorageProvider upload check failed for expected status {expected_status}')
    return json.loads(result.stdout)


def cli_run(cli, state, command, upload_url=None, expected_exit=0):
    env = {'PATH': os.environ['PATH'], 'HOME': str(state), 'AFK_HOME': str(state / '.afk')}
    if upload_url:
        env['OBJECT_UPLOAD_URL'] = upload_url
    result = subprocess.run([cli, *command], cwd=state, env=env, capture_output=True, text=True, timeout=20)
    if upload_url:
        signature = parse_qs(urlsplit(upload_url).query)['X-Amz-Signature'][0]
        assert signature not in result.stdout and signature not in result.stderr, 'CLI disclosed the signature'
        for record in (state / '.afk').rglob('*'):
            if record.is_file():
                assert signature.encode() not in record.read_bytes(), 'CLI persisted the signature'
    assert result.returncode == expected_exit, f'Unexpected CLI exit for {command[:2]}: {result.returncode}'
    return result


def cli_put(cli, state, upload_url, name, payload, expected_status):
    input_file = state / 'upload.json'
    input_file.write_text(json.dumps(dict(name=name, mediaType='application/octet-stream',
                                          bytes=base64.b64encode(payload).decode())))
    result = cli_run(cli, state, ['plugin', 'invoke', 'artifact.provider', 'object-storage', 'put',
                                  '--json', '--input', input_file], upload_url, 0 if expected_status == 200 else 1)
    if expected_status == 200:
        reference = urlsplit(upload_url)._replace(query='').geturl()
        assert json.loads(result.stdout) == {'name': name, 'uri': reference}
        return dict(status=200, referenceQueryRemoved=True)
    assert 'Provider HTTP request failed (403)' in result.stderr and not result.stdout.strip()
    return dict(status=403, exit=result.returncode)


def qualify(server_binary, runtime, cli=None):
    with tempfile.TemporaryDirectory(prefix='afk-presigned-') as temporary:
        state = Path(temporary)
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            address = f'127.0.0.1:{reservation.getsockname()[1]}'
        endpoint = f'http://{address}'
        user, password = secrets.token_hex(8), secrets.token_hex(16)
        env = dict(os.environ, MINIO_ROOT_USER=user, MINIO_ROOT_PASSWORD=password,
                   MINIO_BROWSER='off', MINIO_UPDATE='off')
        command = [server_binary, 'server', '--address', address, '--console-address', '127.0.0.1:0',
                   '--certs-dir', state / 'certs', state / 'objects']
        with subprocess.Popen(command, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as server:
            try:
                deadline = time.monotonic() + 15
                while True:
                    assert server.poll() is None, 'MinIO exited during startup'
                    try:
                        with urlopen(f'{endpoint}/minio/health/ready', timeout=1) as response:
                            assert response.status == 200
                        break
                    except OSError:
                        if time.monotonic() >= deadline:
                            raise RuntimeError('MinIO did not become ready') from None
                        time.sleep(0.1)

                storage = boto3.client('s3', endpoint_url=endpoint, region_name='us-east-1', aws_access_key_id=user,
                                       aws_secret_access_key=password, config=Config(signature_version='s3v4',
                                       proxies={}, s3={'addressing_style': 'path'}))
                name, bucket = 'qualification.bin', 'qualification'
                storage.create_bucket(Bucket=bucket)
                if cli:
                    cli_state = state / 'cli-profile'
                    cli_state.mkdir()
                    cli_version = cli_run(cli, cli_state, ['--version']).stdout.strip()
                    settings = cli_state / 'settings.json'
                    settings.write_text(json.dumps({'presignedUrl': {'env': 'OBJECT_UPLOAD_URL'}}))
                    cli_run(cli, cli_state, ['plugin', 'configure', 'artifact.object-storage', '--builtin', '--file', settings])
                ttl_seconds = 8
                upload_url = storage.generate_presigned_url('put_object', Params={'Bucket': bucket, 'Key': name},
                                                            ExpiresIn=ttl_seconds)
                payload = bytes(range(256)) * 16 + b'\x00\xff\n'
                accepted = cli_put(cli, cli_state, upload_url, 'local-report.bin', payload, 200) if cli else put(runtime, upload_url, name, payload, 200)
                signing_time = parse_qs(urlsplit(upload_url).query)['X-Amz-Date'][0]
                expiry = datetime.strptime(signing_time, '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc).timestamp() + ttl_seconds
                time.sleep(max(0, expiry - time.time() + 1))
                if cli:
                    cli_expired = cli_put(cli, cli_state, upload_url, 'local-report.bin', b'expired replacement', 403)
                refused = put(runtime, upload_url, name, b'expired replacement', 403)
                with storage.get_object(Bucket=bucket, Key=name)['Body'] as body:
                    stored = body.read()
                assert stored == payload, 'Expired PUT changed the existing bytes'
            finally:
                if server.poll() is None:
                    server.terminate()
                    try:
                        server.wait(timeout=8)
                    except subprocess.TimeoutExpired:
                        server.kill()
                        server.wait(timeout=8)
    version = subprocess.check_output([server_binary, '--version'], text=True, timeout=15).splitlines()[0]
    return dict(server=version, runtimeModuleSha256=sha256(runtime.read_bytes()), ttlSeconds=ttl_seconds,
                accepted=accepted, expired=refused, bytes=len(stored), inputSha256=sha256(payload),
                readbackSha256=sha256(stored), serverStopped=True, temporaryDataRemoved=not state.exists(),
                **(dict(cli=cli_version, cliExpired=cli_expired, cliSignatureAbsent=True) if cli else {}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Qualify an installed ObjectStorageProvider against local MinIO')
    parser.add_argument('minio', type=Path)
    parser.add_argument('installed_artifact_module', type=Path)
    parser.add_argument('--cli', type=Path)
    args = parser.parse_args()
    print(json.dumps(qualify(args.minio.resolve(strict=True), args.installed_artifact_module.resolve(strict=True),
                             args.cli.absolute() if args.cli else None), indent=2))
