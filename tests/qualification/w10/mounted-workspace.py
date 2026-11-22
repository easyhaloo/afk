#!/usr/bin/env python3
"""Exercise an installed AFK and two loopback Apache virtual hosts with real Git CGI."""
import argparse
from contextlib import ExitStack
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from http.client import HTTPSConnection
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def qualify(args, root, stack):
    node = shutil.which('node')
    entry = args.afk.resolve(strict=True)
    cli = [node, entry / 'dist/index.js'] if entry.is_dir() else [entry]
    env = dict(PATH=os.pathsep.join([str(Path(node).parent), os.defpath]), HOME=str(root), GIT_CONFIG_NOSYSTEM='1',
               GIT_CONFIG_GLOBAL='/dev/null', GIT_TERMINAL_PROMPT='0', NO_PROXY='127.0.0.1',
               NODE_EXTRA_CA_CERTS=str(root / 'tls.pem'), AFK_MOUNT_TOKEN=secrets.token_hex(32))

    def run(*command, checked=True):
        result = subprocess.run(command, cwd=root, env=env, capture_output=True, text=True, timeout=45)
        if checked:
            check(not result.returncode, result.stderr.replace(env['AFK_MOUNT_TOKEN'], '[redacted]'))
        return result

    def git(directory, *arguments):
        return run('git', '-C', directory, *arguments).stdout.strip()

    def configure(plugin, data):
        (root / 'config.json').write_text(json.dumps(data))
        run(*cli, 'plugin', 'configure', plugin, '--builtin', '--file', 'config.json')

    service = root / 'cgi/mounted'
    service.parent.mkdir()
    original = Path(__file__).resolve().parents[3] / 'services/mounted-workspace/workspace.py'
    run('install', '-m', '700', original, service)
    (root / 'secret').write_text(env['AFK_MOUNT_TOKEN'])
    (root / 'cert.conf').write_text('[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=CA:TRUE\n')
    run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', 'tls.key', '-out', 'tls.pem', '-config', 'cert.conf')
    git_port, api_port = port(), port()
    git_url = f'http://127.0.0.1:{git_port}/git/parcel.git'
    endpoint = f'https://127.0.0.1:{api_port}'
    bare, mirror, mount = root / 'origins/parcel.git', root / 'mirror', root / 'mount'
    claims = root / '.afk/state/claims/repositories'
    for directory in [bare.parent, mount, claims]:
        directory.mkdir(parents=True)
    git(root, 'init', '--bare', '-b', 'main', str(bare))
    git(bare, 'config', 'http.receivepack', 'true')
    git(root, 'init', '-b', 'main', str(mirror))
    git(mirror, 'config', 'user.name', 'Fixture')
    git(mirror, 'config', 'user.email', 'qa@example.invalid')
    git(mirror, 'commit', '--allow-empty', '-m', 'base')
    base = git(mirror, 'rev-parse', 'HEAD')
    git(mirror, 'switch', '-c', 'source')
    (mirror/'parcel.txt').write_text('synthetic parcel\n')
    git(mirror, 'add', 'parcel.txt')
    git(mirror, 'commit', '-m', 'source')
    source = git(mirror, 'rev-parse', 'HEAD')
    git(mirror, 'push', str(bare), 'main', 'source')
    git(mirror, 'remote', 'add', 'origin', git_url)
    config = root/'service.json'
    lease_key = 'gitlab:fixture/parcel'
    managed = dict(name='parcel', gitDirectory=str(mirror/'.git'), remoteUrl=git_url, leaseKey=lease_key)
    config.write_text(json.dumps(dict(**managed, baseBranch='main', workspaceRoot=str(mount), claimsRoot=str(claims), tokenFile=str(root/'secret'))))
    backend = Path(git(root, '--exec-path')) / 'git-http-backend'
    modules = ['mpm_prefork','unixd','authz_core','alias','env','cgi','ssl']
    httpd = args.httpd
    builtins = run(httpd, '-l').stdout
    loads = '\n'.join(f'LoadModule {module}_module "{args.modules}/mod_{module}.so"' for module in modules
                      if f'mod_{module}.c' not in builtins and (module != 'mpm_prefork' or 'prefork.c' not in builtins))
    apache = root / 'apache.conf'
    apache.write_text(f'''ServerRoot "{root}"
ServerName localhost
PidFile "{root}/apache.pid"
DefaultRuntimeDir "{root}"
Mutex file:{root} default
DocumentRoot "{service.parent}"
<Directory />
Require all denied
</Directory>
ErrorLog "{root}/error.log"
{loads}
Listen 127.0.0.1:{git_port}
Listen 127.0.0.1:{api_port}
<VirtualHost 127.0.0.1:{git_port}>
ScriptAlias /git "{backend}"
SetEnv GIT_PROJECT_ROOT "{bare.parent}"
SetEnv GIT_HTTP_EXPORT_ALL 1
<Directory "{backend.parent}">
Require all granted
</Directory>
</VirtualHost>
<VirtualHost 127.0.0.1:{api_port}>
SSLEngine on
SSLCertificateFile "{root}/tls.pem"
SSLCertificateKeyFile "{root}/tls.key"
SSLOptions +StdEnvVars
ScriptAlias /workspaces "{service}"
SetEnv AFK_WORKSPACE_CONFIG "{config}"
<Directory "{service.parent}">
CGIPassAuth On
Require all granted
</Directory>
</VirtualHost>
''')
    tls = ssl.create_default_context(cafile=str(root/'tls.pem'))

    def api(name, method='GET', body=None, authorized=True):
        connection = HTTPSConnection('127.0.0.1', api_port, context=tls, timeout=4)
        try:
            headers = {'Authorization': 'Bearer ' + env['AFK_MOUNT_TOKEN']} if authorized else {}
            connection.request(method, '/workspaces/'+name, None if body is None else json.dumps(body), headers)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def start():
        run(httpd, '-t', '-f', apache)
        with (root/'error.log').open('a') as log:
            server_env = {key:value for key,value in env.items() if key != 'AFK_MOUNT_TOKEN'}
            process = subprocess.Popen([httpd, '-DFOREGROUND', '-f', apache], cwd=root, env=server_env,
                                       stdout=subprocess.DEVNULL, stderr=log, start_new_session=True)
        def stop():
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
        stack.callback(stop)
        for attempt in range(100):
            check(process.poll() is None, (root/'error.log').read_text()[-800:] if (root/'error.log').exists() else 'Apache exited')
            try:
                status, raw = api('parcel/snapshot', authorized=False)
                check(status == 401, f'auth check {status} {raw[:160]}')
                return stop
            except ConnectionRefusedError:
                time.sleep(.05)
        raise RuntimeError('Apache unavailable')

    stop = start()
    check(api('other/snapshot')[0] == 404, 'repository allowlist')
    repository = dict(url='parcel', ref='main')
    prepare = dict(repository=repository, runId='no-claim')
    check(api('parcel/prepare', 'POST', prepare)[0] == 409, 'prepare without claim')
    configure('repository.remote-workspace', dict(baseUrl=endpoint, token={'env':'AFK_MOUNT_TOKEN'},
              managed=dict(workspaceRoot=str(mount), repositories=[managed]),
              lifecycle=dict(repositories=[repository],operations=['prepare','checkout','publish','cleanup'])))

    def invoke(run_id, action, checked=True):
        payload = dict(repository=repository, runId=run_id, checkout=dict(ref='source',branch='afk/'+run_id),
                       action='capability.invoke', input=action)
        (root/'input.json').write_text(json.dumps(payload))
        return run(*cli,'plugin','invoke','repository.provider','remote-workspace','run','--input','input.json','--json',checked=checked)

    def inspect():
        return json.loads(run(service, config, 'inspect').stdout)

    ready = threading.Event()
    resume = threading.Event()
    class Gate(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers['Content-Length']))
            ready.set()
            resume.wait(12)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"uri":"http://127.0.0.1/synthetic"}')

        def log_message(self, *args):
            pass

    gate = HTTPServer(('127.0.0.1',0),Gate)
    stack.callback(gate.server_close)
    threading.Thread(target=gate.handle_request,daemon=True).start()
    configure('artifact.report-platform', {'endpoint':f'http://127.0.0.1:{gate.server_port}/gate'})
    gate_action = dict(capability='artifact.provider',provider='report-platform',operation='put',input=dict(name='gate.txt',mediaType='text/plain',bytes='YQ=='))
    with ThreadPoolExecutor() as pool:
        failure = pool.submit(invoke,'disconnect',gate_action,False)
        try:
            for attempt in range(100):
                if ready.wait(.1) or failure.done():
                    break
            if failure.done():
                raise RuntimeError('run exited before action: '+failure.result().stderr)
            check(ready.is_set(),'action barrier not reached')
            lease = inspect()
            checkout = mount/'parcel@disconnect'
            check(git(checkout,'rev-parse','HEAD') == source and git(checkout,'branch','--show-current') == 'afk/disconnect','independent checkout')
            check(run(service,config,'recover',lease['id'],checked=False).returncode != 0,'live recovery accepted')
            check(api('parcel/prepare','POST',prepare)[0] == 409,'duplicate prepare accepted')
            observed = dict(workspaceId=lease['id'], expectedBranch='afk/disconnect', expectedCommit=source)
            route = 'parcel/sessions/'+lease['id']+'/publish'
            check(api(route,'POST',dict(observed,merge=True))[0] == 403,'merge accepted')
            check(api(route,'POST',dict(observed,expectedCommit=base,merge=False))[0] == 409,'mismatched commit accepted')
            stop()
            try:
                api('parcel/snapshot')
            except ConnectionRefusedError:
                pass
            else:
                raise RuntimeError('workspace listener still reachable')
        finally:
            resume.set()
        failed = failure.result()
    check(failed.returncode and checkout.exists(),'disconnect should retain checkout')
    start()
    check(inspect() == lease and not git(bare,'branch','--list','afk/disconnect'),'lease or remote changed')
    check(run(service,config,'recover','wrong',checked=False).returncode != 0,'wrong lease accepted')
    marker = checkout/'unsaved'
    marker.write_text('preserve me')
    check(run(service,config,'recover',lease['id'],checked=False).returncode != 0 and marker.read_text() == 'preserve me','dirty recovery')
    marker.unlink()
    git(checkout, 'commit', '--allow-empty', '-m', 'unpublished synthetic change')
    unpublished = git(checkout, 'rev-parse', 'HEAD')
    check(run(service,config,'recover',lease['id'],checked=False).returncode != 0
          and git(checkout,'rev-parse','HEAD') == unpublished,'unpublished commit lost')
    git(checkout, 'branch', '-m', 'preserved-unpublished')
    git(checkout, 'switch', '-c', 'afk/disconnect', source)
    recovered = json.loads(run(service,config,'recover',lease['id']).stdout)
    check(recovered == {'removed':True} and not checkout.exists() and inspect() is None,'recovery postcondition')
    action = dict(capability='repository.provider',provider='remote-workspace',operation='snapshot',input={'url':'parcel'})
    success = json.loads(invoke('disconnect',action).stdout)
    branch = 'afk/disconnect'
    check(success['workspace']['id'] != lease['id'] and success['value'] == dict(commit=source,branch=branch,dirty=False)
          and success['publication']==dict(commit=source,branch=branch) and success['cleanup']=={'removed':True},'installed lifecycle result')
    check(git(bare,'rev-parse','main')==base and git(bare,'rev-parse',branch)==source and git(bare,'show',branch+':parcel.txt')=='synthetic parcel','bare Git readback')
    check(not list(mount.iterdir()) and inspect() is None,'final mount and lease')
    check(success['workspace']['path'] == str(checkout), 'reported mounted path')
    success['workspace']['path'] = '$FIXTURE/mount/parcel@disconnect'
    return dict(afk=run(*cli,'--version').stdout.strip(), apache=run(httpd,'-v').stdout.splitlines()[0],git=git(root,'--version'),serviceGit=run('/usr/bin/git','--version').stdout.strip(),
                service_sha256=sha256(service.read_bytes()).hexdigest(),base=base,source=source,
                outage=dict(runId=lease['runId'],claimId=lease['claim'],session=lease['id'],cliExit=failed.returncode,diagnostic=failed.stderr.strip(),
                            checkoutCommit=source,retainedAcrossRestart=True,remoteBranchAbsent=True,recovered=recovered),
                unpublished=dict(commit=unpublished,preserved=git(mirror,'rev-parse','preserved-unpublished')),
                refusals=['401 missing bearer','404 unknown repository','409 prepare without claim','409 second prepare','403 merge','409 stale commit','live owner','wrong session','dirty checkout','unpublished commit'],
                retry=success,readback={'main':base,branch:source,'parcel.txt':'synthetic parcel'},remainingMounts=0)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('afk', type=Path)
    parser.add_argument('--httpd', default=shutil.which('httpd') or shutil.which('apache2'))
    parser.add_argument('--modules', type=Path, default='/usr/libexec/apache2' if Path('/usr/libexec/apache2').exists() else '/usr/lib/apache2/modules')
    args = parser.parse_args()
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix='afk-mounted-') as directory, ExitStack() as stack:
        result = qualify(args, Path(directory).resolve(), stack)
    print(json.dumps(result,indent=2))
