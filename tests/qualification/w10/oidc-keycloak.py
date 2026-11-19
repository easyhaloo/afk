"""Run with Python 3.11+, Docker, OpenSSL, Node and a trusted packaged AFK archive."""
import base64
import hashlib
import http.client
import json
import os
import secrets
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode


IMAGE = 'quay.io/keycloak/keycloak@sha256:9409c59bdfb65dbffa20b11e6f18b8abb9281d480c7ca402f51ed3d5977e6007'
ACCESS = 'urn:ietf:params:oauth:token-type:access_token'
EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange'
REALM = '/realms/w10'
TOKEN = REALM + '/protocol/openid-connect/token'
DISCOVERY = REALM + '/.well-known/openid-configuration'
CLIENT = 'w10-exchanger'
REPORT = 'w10-reports'
SCOPE = 'report.write'


def require(value, message):
    if not value:
        raise RuntimeError(message)


def encoded(value):
    return base64.urlsafe_b64encode(value).rstrip(b'=')


def realm(certificate, resource_secret, source_secret):
    def client(name, **options):
        return dict(clientId=name, enabled=True, protocol='openid-connect', standardFlowEnabled=False,
                    defaultClientScopes=[], optionalClientScopes=[], **options)

    def mapper(audience):
        return dict(name=audience, protocol='openid-connect', protocolMapper='oidc-audience-mapper',
                    config={'included.client.audience': audience, 'access.token.claim': 'true',
                            'introspection.token.claim': 'true'})

    requester = client(CLIENT, clientAuthenticatorType='client-jwt', serviceAccountsEnabled=True,
                       attributes={'jwt.credential.certificate': certificate,
                                   'standard.token.exchange.enabled': 'true',
                                   'access.token.lifespan': '15'})
    requester['optionalClientScopes'] = [SCOPE]
    return dict(realm='w10', enabled=True, accessTokenLifespan=240, sslRequired='none',
                clientScopes=[dict(name=SCOPE, protocol='openid-connect', attributes={'include.in.token.scope': 'true'},
                                   protocolMappers=[mapper(REPORT)])],
                clients=[requester, client(REPORT, secret=resource_secret), client('w10-other', publicClient=True),
                         client('w10-source', secret=source_secret, serviceAccountsEnabled=True,
                                protocolMappers=[mapper(CLIENT)])])


def exercise(root, archive, digest):
    env = {'HOME': str(root), 'PATH': os.environ['PATH'], 'NODE_EXTRA_CA_CERTS': str(root / 'tls.crt'),
           'AFK_EVENT_STORE_DIR': str(root / 'events'), 'TMPDIR': str(root)}

    def run(command, data=None, extra=None, success=True, timeout=60):
        proc = subprocess.run(command, cwd=root, env=env | (extra or {}), input=data, capture_output=True, timeout=timeout)
        if success:
            require(proc.returncode == 0, f'{Path(command[0]).name} {command[1]} exited {proc.returncode}')
        return proc

    def cert(name):
        run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=w10',
             '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', name + '.key', '-out', name + '.crt'])

    run(['tar', '-xzf', str(archive)])
    cli = ['node', str(root / 'afk/dist/index.js')]
    release = json.loads((root / 'afk/release.json').read_bytes())
    require(run(cli + ['--version']).stdout.decode().strip() == release['version'], 'CLI version mismatch')
    for command in ('configure', 'invoke'):
        run(cli + ['plugin', command, '--help'])
    cert('tls')
    cert('client')
    certificate = ''.join((root / 'client.crt').read_text().splitlines()[1:-1])
    resource_secret, source_secret, admin_secret = (secrets.token_hex(32) for _ in range(3))
    (root / 'import').mkdir()
    (root / 'import/w10-realm.json').write_text(json.dumps(realm(certificate, resource_secret, source_secret)))
    (root / 'import/w10-realm.json').chmod(0o644)
    (root / 'import').chmod(0o755)
    (root / 'docker').mkdir()
    docker = ['docker', '--config', str(root / 'docker'), '-H', 'unix:///var/run/docker.sock']
    name = 'w10-oidc-' + secrets.token_hex(6)
    trace = []
    reports = []
    document = secrets.token_bytes(24)
    upstream_port = None

    def upstream(method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', upstream_port, timeout=8)
        try:
            conn.request(method, path, body, headers or {})
            response = conn.getresponse()
            return response.status, response.read()
        finally:
            conn.close()

    def post(path, form):
        status, raw = upstream('POST', path, urlencode(form), {'Content-Type': 'application/x-www-form-urlencoded'})
        return status, json.loads(raw)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def respond(self, status, raw):
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            if self.path != DISCOVERY:
                return self.respond(404, b'{}')
            status, raw = upstream('GET', DISCOVERY)
            trace.append({'discoveryHttp': status})
            self.respond(status, raw)

        def do_POST(self):
            body = self.rfile.read(int(self.headers['Content-Length']))
            if self.path == TOKEN:
                form = parse_qs(body.decode())
                status, raw = upstream('POST', TOKEN, body, {'Content-Type': self.headers['Content-Type']})
                answer = json.loads(raw)
                trace.append({'tokenHttp': status, 'grant': form['grant_type'][0], 'audience': form.get('audience', []),
                              'assertionType': form['client_assertion_type'][0], 'scope': form.get('scope', []),
                              'result': answer.get('error', answer.get('issued_token_type', 'issued'))})
                return self.respond(status, raw)
            if self.path != '/reports':
                return self.respond(404, b'{}')
            scheme, _, token = self.headers.get('Authorization', '').partition(' ')
            status, info = post(TOKEN + '/introspect', dict(token=token, client_id=REPORT, client_secret=resource_secret))
            audiences = info.get('aud', [])
            if isinstance(audiences, str):
                audiences = [audiences]
            accepted = (scheme == 'Bearer' and status == 200 and info.get('active') is True and REPORT in audiences and
                        info.get('iss') == issuer and SCOPE in info.get('scope', '').split() and
                        info.get('azp') == CLIENT and info['iat'] <= time.time() < info['exp'] and body == document)
            reports.append((token, {'active': info.get('active'), 'audiences': audiences, 'issuerMatches': info.get('iss') == issuer,
                                    'client': info.get('azp'), 'scope': info.get('scope'), 'issuedAt': info.get('iat'),
                                    'expiresAt': info.get('exp'), 'resourceHttp': 200 if accepted else 401}))
            self.respond(200 if accepted else 401, json.dumps({'uri': origin + '/saved'}).encode())

    with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
        origin = f'https://127.0.0.1:{server.server_port}'
        issuer = origin + REALM
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(root / 'tls.crt', root / 'tls.key')
        server.socket = tls.wrap_socket(server.socket, server_side=True)
        run(docker + ['create', '--name', name, '-p', '127.0.0.1::8080', '-e', 'KC_BOOTSTRAP_ADMIN_USERNAME=w10',
                      '-e', 'KC_BOOTSTRAP_ADMIN_PASSWORD', IMAGE, 'start-dev', '--hostname', origin, '--import-realm'],
            extra={'KC_BOOTSTRAP_ADMIN_PASSWORD': admin_secret})
        try:
            run(docker + ['cp', str(root / 'import'), name + ':/opt/keycloak/data/'])
            run(docker + ['start', name])
            upstream_port = int(run(docker + ['port', name, '8080/tcp']).stdout.split(b':')[-1])
            for _ in range(100):
                try:
                    status, raw = upstream('GET', DISCOVERY)
                    if status == 200 and json.loads(raw)['issuer'] == issuer:
                        break
                except OSError:
                    pass
                time.sleep(1)
            else:
                raise RuntimeError('Local realm discovery did not become ready')
            threading.Thread(target=server.serve_forever, daemon=True).start()
            def assertion(audience, lifetime=60):
                now = int(time.time())
                claims = dict(iss=CLIENT, sub=CLIENT, aud=audience, iat=now if lifetime > 0 else now-120,
                              exp=now+lifetime, jti=secrets.token_hex(16))
                signing = encoded(b'{"alg":"RS256","typ":"JWT"}') + b'.' + encoded(json.dumps(claims).encode())
                signature = run(['openssl', 'dgst', '-sha256', '-sign', 'client.key'], signing).stdout
                return (signing + b'.' + encoded(signature)).decode()

            def configure(provider, config):
                (root / 'config.json').write_text(json.dumps(config))
                run(cli + ['plugin', 'configure', provider, '--builtin', '--file', 'config.json'])

            source_http, source = post(TOKEN, dict(grant_type='client_credentials', client_id='w10-source', client_secret=source_secret))
            require(source_http == 200, 'subject issuance failed')
            source_token = source['access_token']
            (root / 'input.json').write_text(json.dumps(dict(name='report.bin', mediaType='application/octet-stream',
                                                            bytes=base64.b64encode(document).decode())))
            evidence = {}

            def invoke(label, *, target=REPORT, jwt_aud=None, lifetime=60, pin=None, expected_status=200, expected_error=None):
                config = dict(issuer=issuer, clientId=CLIENT, assertion={'env': 'W10_ASSERTION'}, tokenEndpoint=pin or origin+TOKEN,
                              exchange=dict(subjectToken={'env': 'W10_SUBJECT'}, subjectTokenType=ACCESS, audience=target))
                configure('credential.oidc', config)
                if not evidence:
                    configure('artifact.report-platform', dict(endpoint=origin+'/reports', token=dict(provider='credential.oidc', name='reports', scope=SCOPE)))
                start, previous = len(trace), len(reports)
                proc = run(cli + ['plugin', 'invoke', 'artifact.provider', 'report-platform', 'put', '--input', 'input.json', '--json'],
                           extra={'W10_ASSERTION': assertion(jwt_aud or issuer, lifetime), 'W10_SUBJECT': source_token}, success=False)
                events = trace[start:]
                record = dict(cliExit=proc.returncode, requests=events, reportRequests=len(reports)-previous)
                evidence[label] = record
                print(label, json.dumps(record), file=sys.stderr, flush=True)
                require(events[:1] == [{'discoveryHttp': 200}], label + ' discovery')
                if expected_status is None:
                    require(len(events) == 1, label + ' sent a token request')
                else:
                    require(len(events) == 2 and events[1] == dict(tokenHttp=expected_status, grant=EXCHANGE, audience=[target],
                            assertionType='urn:ietf:params:oauth:client-assertion-type:jwt-bearer', scope=[SCOPE],
                            result=expected_error or ACCESS), label + ' unexpected IdP response')
                if expected_status == 200:
                    require(proc.returncode == 0 and len(reports) == previous+1 and reports[-1][1]['resourceHttp'] == 200,
                            label + ' report validation failed')
                    require(json.loads(proc.stdout) == dict(name='report.bin', uri=origin+'/saved'), label + ' returned artifact')
                    record['report'] = reports[-1][1]
                else:
                    require(proc.returncode == 1 and proc.stderr.strip() == b'Operation credential unavailable' and
                            not proc.stdout.strip() and len(reports) == previous, label + ' unexpected CLI result')

            invoke('validExchange')
            first_token, first_report = reports[-1]
            invoke('wrongEndpointPin', pin=origin+'/other', expected_status=None)
            invoke('wrongAssertionAudience', jwt_aud=origin+'/other', expected_status=400, expected_error='invalid_client')
            invoke('expiredAssertion', lifetime=-60, expected_status=400, expected_error='invalid_client')
            invoke('ungrantedTargetAudience', target='w10-other', expected_status=400, expected_error='invalid_request')
            def admin(*args):
                command = docker + ['exec', '-e', 'KC_CLI_PASSWORD', name, '/opt/keycloak/bin/kcadm.sh', *args,
                                    '--config', '/tmp/w10-kcadm.config']
                result = run(command, extra={'KC_CLI_PASSWORD': admin_secret}, success=False)
                require(result.returncode == 0, f'kcadm {args[0]} failed')
                return result.stdout

            admin('config', 'credentials', '--server', 'http://localhost:8080', '--realm', 'master', '--user', 'w10')
            targets = json.loads(admin('get', 'clients', '-r', 'w10', '-q', 'clientId='+REPORT, '--fields', 'id,clientId'))
            require(len(targets) == 1 and targets[0]['clientId'] == REPORT, 'find synthetic target')
            path = 'clients/' + targets[0]['id']
            admin('update', path, '-r', 'w10', '-s', 'enabled=false')
            invoke('disabledAudienceClient', expected_status=400, expected_error='invalid_client')
            admin('update', path, '-r', 'w10', '-s', 'enabled=true')
            invoke('restoredAudienceClient')
            revoke_token, revoke_report = reports[-1]
            require(revoke_token != first_token, 'expected distinct tokens for expiry and revocation')

            def rejected_report(token, expires_at):
                conn = http.client.HTTPSConnection('127.0.0.1', server.server_port, timeout=8, context=ssl.create_default_context(cafile=root/'tls.crt'))
                try:
                    conn.request('POST', '/reports', document, {'Authorization': 'Bearer '+token})
                    response = conn.getresponse()
                    require(response.status == 401 and reports[-1][0] == token and reports[-1][1]['active'] is False,
                            'expected inactive bearer and resource rejection')
                    return dict(checkedAt=int(time.time()), expiresAt=expires_at, active=False, resourceHttp=response.status)
                finally:
                    conn.close()

            form = urlencode(dict(token=revoke_token, token_type_hint='access_token', client_id=CLIENT,
                                  client_assertion_type='urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
                                  client_assertion=assertion(issuer)))
            status, _ = upstream('POST', REALM+'/protocol/openid-connect/revoke', form, {'Content-Type': 'application/x-www-form-urlencoded'})
            require(status == 200, f'access-token revocation returned {status}')
            rejected = rejected_report(revoke_token, revoke_report['expiresAt'])
            require(rejected['checkedAt'] < rejected['expiresAt'], 'bearer expired before revocation could be observed')
            evidence['revokedBearerReplay'] = dict(rejected, revocationHttp=status)
            invoke('newExchangeAfterRevocation')
            time.sleep(max(0, first_report['expiresAt']+2-time.time()))
            evidence['expiredBearerReplay'] = rejected_report(first_token, first_report['expiresAt'])
            server.shutdown()
            return dict(observed=datetime.now(timezone.utc).isoformat(), release=release, archiveSha256=digest, idpImage=IMAGE,
                        entry='plugin invoke artifact.provider report-platform put', cases=evidence)
        finally:
            run(docker + ['rm', '-f', '-v', name])


if __name__ == '__main__':
    archive = Path(sys.argv[1]).resolve(strict=True)
    with archive.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    require(Path(str(archive)+'.sha256').read_text().split() == [digest, archive.name], 'archive checksum mismatch')
    with tempfile.TemporaryDirectory(prefix='w10-oidc-') as temporary:
        receipt = exercise(Path(temporary), archive, digest)
    print(json.dumps(receipt, indent=2))
