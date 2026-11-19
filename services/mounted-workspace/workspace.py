#!/usr/bin/env python3
"""AFK mounted repository service (Apache CGI) and local recovery tool."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import subprocess
import sys
from urllib.parse import urlsplit


class Refusal(Exception):
    def __init__(self, status, reason):
        super().__init__(reason)
        self.status = status


def require(condition, reason, status=409):
    if not condition:
        raise Refusal(status, reason)


def identifier(value):
    require(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', value)
            and '..' not in value, 'invalid identifier', 400)
    return value


def canonical(directory):
    path = Path(directory)
    require(path.is_absolute() and path.resolve(strict=True) == path and path.is_dir(), 'invalid configured directory')
    return path


def git(directory, *args):
    result = subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
                             '-c', 'http.followRedirects=false', '-C', directory, *args],
                            env={'PATH': os.defpath, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
                                 'GIT_TERMINAL_PROMPT': '0', 'GIT_ALLOW_PROTOCOL': 'http:https'},
                            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=12)
    require(result.returncode == 0, 'git operation refused')
    return result.stdout.rstrip('\n')


def snapshot(directory):
    flags = git(directory, 'ls-files', '-v', '-z').split('\0')
    require(not any(entry and (entry[0].islower() or entry[0] == 'S') for entry in flags), 'hidden index entries')
    return dict(commit=git(directory, 'rev-parse', 'HEAD'), branch=git(directory, 'rev-parse', '--abbrev-ref', 'HEAD'),
                dirty=bool(git(directory, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none')))


class Workspace:
    def __init__(self, config):
        self.name = identifier(config['name'])
        self.root = canonical(config['workspaceRoot'])
        self.repo = canonical(config['gitDirectory'])
        require(str(self.repo) == git(self.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'invalid repository')
        self.origin = config['remoteUrl']
        url = urlsplit(self.origin)
        require(url.scheme in ('http', 'https') and url.hostname and not (url.username or url.password or url.query or url.fragment), 'invalid origin')
        for flags in ([], ['--push']):
            require(git(self.repo, 'remote', 'get-url', *flags, '--all', 'origin') == self.origin, 'origin changed')
        self.base = config['baseBranch']
        git(self.repo, 'check-ref-format', '--branch', self.base)
        claims = canonical(config['claimsRoot'])
        key = config['leaseKey']
        require(re.fullmatch(r'(github|gitlab):[a-zA-Z0-9_./:-]+', key), 'invalid lease key')
        key = key.lower() if key.startswith('github:') else key
        self.claim = claims / hashlib.sha256(key.encode()).hexdigest() / 'execution/lock/claim.json'
        self.prefix = config.get('branchPrefix', 'afk/')
        require(self.prefix.endswith('/'), 'invalid branch prefix')
        git(self.repo, 'check-ref-format', 'refs/heads/' + self.prefix + 'check')
        bindings = [self.name, self.origin, self.base, self.prefix, str(self.claim)]
        for path in (claims, self.repo, self.root):
            bindings.extend([str(path), path.stat().st_dev, path.stat().st_ino])
        self.policy = hashlib.sha256(json.dumps(bindings).encode()).hexdigest()

    @contextmanager
    def locked(self):
        with (self.repo / 'afk-mounted.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Refusal(409, 'repository operation in progress') from None
            self.db = sqlite3.connect(self.repo / 'afk-mounted.sqlite', isolation_level=None)
            try:
                self.db.execute('CREATE TABLE IF NOT EXISTS lease (slot INTEGER PRIMARY KEY CHECK(slot=1), value TEXT NOT NULL)')
                row = self.db.execute('SELECT value FROM lease WHERE slot=1').fetchone()
                self.session = json.loads(row[0]) if row else None
                require(not self.session or self.session['policy'] == self.policy, 'lease configuration changed')
                yield
            finally:
                self.db.close()

    def save(self):
        self.db.execute('INSERT OR REPLACE INTO lease VALUES(1,?)', (json.dumps(self.session),))

    def generation(self):
        try:
            return identifier(json.loads(self.claim.read_text())['claimId'])
        except FileNotFoundError:
            require(not self.claim.parent.exists(), 'claim transition in progress')
            return None

    def prepare(self, body):
        require(not self.session, 'repository already leased')
        run = identifier(body.get('runId'))
        require(body.get('repository') == {'url': self.name, 'ref': self.base}, 'repository/ref denied', 403)
        generation = self.generation()
        require(generation, 'active AFK claim required')
        path = self.root / f'{self.name}@{run}'
        require(not os.path.lexists(path), 'mount occupied')
        commit = self.fetch(self.base)
        self.session = dict(id=secrets.token_hex(24), runId=run, claim=generation, policy=self.policy,
                            branch='HEAD', safe=commit, identity=None, removing=False)
        self.save()
        git(self.repo, 'worktree', 'add', '--detach', str(path), commit)
        self.session['identity'] = self.identity(path)
        self.save()
        return self.description(path)

    def fetch(self, ref):
        require(isinstance(ref, str) and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_./-]{0,255}', ref), 'invalid source ref', 400)
        git(self.repo, 'check-ref-format', 'refs/heads/' + ref)
        tracking = 'refs/remotes/origin/' + ref
        git(self.repo, 'fetch', '--no-tags', '--no-recurse-submodules', self.origin, '+refs/heads/' + ref + ':' + tracking)
        return git(self.repo, 'rev-parse', '--verify', tracking + '^{commit}')

    def identity(self, path):
        require(canonical(path) == path and git(path, 'rev-parse', '--show-toplevel') == str(path), 'mount changed')
        admin = canonical(git(path, 'rev-parse', '--absolute-git-dir'))
        require(admin.parent == self.repo / 'worktrees' and (admin / 'gitdir').read_text().rstrip('\n') == str(path / '.git')
                and git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir') == str(self.repo), 'mount registration changed')
        return [path.stat().st_dev, path.stat().st_ino, str(admin), admin.stat().st_ino]

    def description(self, path):
        return dict(id=self.session['id'], runId=self.session['runId'], repository=dict(url=self.name, ref=self.base), snapshot=snapshot(path))

    def operate(self, operation, session_id, body, recovery=False):
        require(self.session and self.session['id'] == session_id, 'unknown session', 404)
        active = self.generation()
        require(active is None if recovery else active == self.session['claim'], 'AFK claim ownership conflict')
        path = self.root / f"{self.name}@{self.session['runId']}"
        if recovery and not os.path.lexists(path) and (self.session['identity'] is None or self.session['removing']):
            registrations = git(self.repo, 'worktree', 'list', '--porcelain', '-z').split('\0')
            require('worktree ' + str(path) not in registrations, 'checkout registration remains')
            self.db.execute('DELETE FROM lease WHERE slot=1')
            return {'removed': True}
        require(self.session['identity'] == self.identity(path), 'mount identity changed')
        state = snapshot(path)
        if operation == 'snapshot':
            return state
        require(not state['dirty'] and state['branch'] == self.session['branch'], 'dirty or changed checkout')
        if operation == 'checkout':
            branch = body.get('branch')
            require(state['branch'] == 'HEAD' and state['commit'] == self.session['safe'], 'checkout already used or changed')
            require(isinstance(branch, str) and branch.startswith(self.prefix) and branch != self.base, 'target branch denied', 403)
            git(self.repo, 'check-ref-format', 'refs/heads/' + branch)
            commit = self.fetch(body['ref']) if 'ref' in body else state['commit']
            existing = git(path, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/' + branch)
            if existing:
                require(existing == f'refs/heads/{branch} {commit}', 'existing branch differs from source')
                git(path, 'switch', '--no-guess', branch)
            else:
                git(path, 'switch', '--no-track', '-c', branch, commit)
            self.session.update(branch=branch, safe=commit)
            self.save()
            return self.description(path)
        if not recovery:
            require((body.get('expectedBranch'), body.get('expectedCommit')) == (state['branch'], state['commit']), 'snapshot mismatch')
        if operation == 'publish':
            require(body.get('merge') is False and state['branch'].startswith(self.prefix) and state['branch'] != self.base, 'publication denied', 403)
            git(path, 'push', '--no-follow-tags', '--recurse-submodules=no', self.origin, state['commit'] + ':refs/heads/' + state['branch'])
            self.session['safe'] = state['commit']
            self.save()
            return dict(commit=state['commit'], branch=state['branch'])
        require(operation == 'cleanup' and state['commit'] == self.session['safe'], 'unpublished checkout')
        self.session['removing'] = True
        self.save()
        git(self.repo, 'worktree', 'remove', str(path))
        self.db.execute('DELETE FROM lease WHERE slot=1')
        return {'removed': True}


def serve(config):
    require(os.environ.get('HTTPS') == 'on', 'TLS required', 403)
    token = Path(config['tokenFile']).read_bytes().strip()
    require(len(token) >= 32 and hmac.compare_digest(os.environ.get('HTTP_AUTHORIZATION', '').encode(), b'Bearer ' + token), 'unauthorized', 401)
    parts = os.environ.get('PATH_INFO', '').split('/')[1:]
    require(len(parts) in (2, 4) and parts[0] == config['name'], 'unknown repository', 404)
    operation = parts[-1]
    session_id = parts[2] if len(parts) == 4 else None
    require((session_id is None and operation in ('prepare', 'snapshot')) or
            (session_id and parts[1] == 'sessions' and operation in ('snapshot', 'checkout', 'cleanup', 'publish')), 'unknown operation', 404)
    require(os.environ['REQUEST_METHOD'] == ('GET' if operation == 'snapshot' else 'POST'), 'method denied', 405)
    length = int(os.environ.get('CONTENT_LENGTH') or 0)
    require(0 <= length <= 8192, 'request too large', 413)
    body = json.loads(sys.stdin.buffer.read(length)) if length else {}
    require(isinstance(body, dict), 'invalid request', 400)
    service = Workspace(config)
    with service.locked():
        if operation == 'prepare':
            return service.prepare(body)
        if session_id is None:
            if not service.session:
                ref = 'refs/heads/' + service.base
                commit, reported = git(service.repo, 'ls-remote', '--refs', '--exit-code', service.origin, ref).split('\t')
                require(reported == ref and re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', commit), 'invalid base revision')
                return dict(commit=commit, branch=service.base, dirty=False)
            session_id = service.session['id']
        if operation != 'snapshot':
            require(body.get('workspaceId') == session_id, 'session mismatch', 403)
        return service.operate(operation, session_id, body)


def main():
    os.umask(0o077)
    if 'GATEWAY_INTERFACE' in os.environ:
        try:
            value = serve(json.loads(Path(os.environ['AFK_WORKSPACE_CONFIG']).read_text()))
            status = 200
        except Refusal as error:
            status, value = error.status, {'error': str(error)}
        except (ValueError, UnicodeError):
            status, value = 400, {'error': 'invalid input'}
        except Exception:
            status, value = 503, {'error': 'workspace unavailable'}
        print(f'Status: {status}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n\r\n' + json.dumps(value))
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config', type=Path)
    parser.add_argument('action', choices=['inspect', 'recover'])
    parser.add_argument('session', nargs='?')
    args = parser.parse_args()
    service = Workspace(json.loads(args.config.read_text()))
    with service.locked():
        result = service.session if args.action == 'inspect' else service.operate('cleanup', args.session, {}, recovery=True)
        print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Refusal as error:
        sys.exit(str(error))
