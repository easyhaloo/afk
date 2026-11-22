#!/usr/bin/env python3
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def git(directory, *args):
    return subprocess.check_output(['git', '-C', directory, *args], text=True, timeout=15).strip()


def snapshot(directory):
    return {'branch': git(directory, 'branch', '--show-current'), 'commit': git(directory, 'rev-parse', 'HEAD'),
            'dirty': bool(git(directory, 'status', '--porcelain'))}


def backend(operation, args):
    root = Path(__file__).resolve().parent
    work = root / 'checkout'
    store = root / 'store'
    assert (root / 'qualification.json').is_file() and args[0] == '--json'
    with (root / 'operations').open('a') as history:
        print(operation, file=history)
    if operation == 'snapshot' and len(args) > 1:
        if args[1:] != ['active']:
            sys.exit(3)
        return snapshot(work)
    request = json.load(sys.stdin)
    assert request['repository'] == {'url': 'parcel', 'ref': 'main'}
    if operation == 'prepare':
        assert request['runId'] == 'parcel-review'
        git(store, 'worktree', 'add', str(work), 'main')
    else:
        assert request['workspaceId'] == 'parcel-work'
    if operation == 'checkout':
        assert request['ref'] == 'source' and request['branch'] == 'review'
        git(work, 'switch', '-C', 'review', 'source')
    if operation in ('prepare', 'checkout'):
        return {'repository': request['repository'], 'id': 'parcel-work', 'runId': 'parcel-review', 'snapshot': snapshot(work)}
    state = snapshot(work)
    if operation == 'snapshot':
        return state
    assert state['commit'] == request['expectedCommit'] and state['branch'] == request['expectedBranch'] and not state['dirty']
    if operation == 'publish':
        assert request['merge'] is False
        git(work, 'push', 'origin', 'HEAD:refs/heads/review')
        return state
    assert operation == 'cleanup'
    git(store, 'worktree', 'remove', str(work))
    return {'removed': not work.exists()}


def qualify(launcher, root):
    root = Path(root)
    executable = root / 'git-adapter'
    shutil.copy2(__file__, executable)
    executable.chmod(0o700)
    profile = root / 'profile'
    profile.mkdir()
    env = {'PATH': os.pathsep.join([str(Path(shutil.which('node')).parent), '/usr/bin', '/bin']), 'HOME': str(profile),
           'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_ALLOW_PROTOCOL': 'file', 'GIT_TERMINAL_PROMPT': '0'}
    os.environ.clear()
    os.environ.update(env)
    data = root / 'qualification.json'

    def cli(*args):
        return subprocess.run([launcher, *args], cwd=root, env=env, capture_output=True, text=True, timeout=45)

    def checked(*args):
        result = cli(*args)
        assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    store = root / 'store'
    remote = root / 'parcel.git'
    git(root, 'init', '--bare', '-b', 'main', str(remote))
    git(root, 'init', '-b', 'main', str(store))
    git(store, 'config', 'user.name', 'Qualification')
    git(store, 'config', 'user.email', 'qualification@example.invalid')
    git(store, 'commit', '--allow-empty', '-m', 'base')
    git(store, 'remote', 'add', 'origin', str(remote))
    git(store, 'push', 'origin', 'main')
    base = git(remote, 'rev-parse', 'refs/heads/main')
    git(store, 'switch', '-c', 'source')
    (store / 'parcel.txt').write_text('ready for review\n')
    git(store, 'add', 'parcel.txt')
    git(store, 'commit', '-m', 'prepare parcel')
    source = git(store, 'rev-parse', 'HEAD')
    repository = {'url': 'parcel', 'ref': 'main'}
    data.write_text(json.dumps({'backend': str(executable), 'lifecycle': {'repositories': [repository],
                               'operations': ['prepare', 'checkout', 'publish', 'cleanup']}}))
    checked('plugin', 'configure', 'repository.special-git-backend', '--builtin', '--file', str(data))
    args = ['plugin', 'invoke', 'repository.provider', 'special-git-backend', 'run', '--input', str(data), '--json']
    request = {'repository': repository, 'runId': 'parcel-review', 'checkout': {'ref': 'source', 'branch': 'review'},
               'action': 'capability.invoke', 'input': {'capability': 'repository.provider', 'provider': 'special-git-backend',
                                                       'operation': 'snapshot', 'input': {'url': 'missing'}}}
    data.write_text(json.dumps(request))
    result = cli(*args)
    history = root / 'operations'
    failed = history.read_text().splitlines()
    assert result.returncode != 0 and failed == ['prepare', 'checkout', 'snapshot', 'snapshot', 'cleanup'], (result, failed)
    assert not (root / 'checkout').exists() and git(remote, 'branch', '--list', 'review') == ''
    request['input']['input']['url'] = 'active'
    data.write_text(json.dumps(request))
    receipt = json.loads(checked(*args))
    succeeded = history.read_text().splitlines()[len(failed):]
    assert succeeded == ['prepare', 'checkout', 'snapshot', 'snapshot', 'publish', 'snapshot', 'cleanup']
    assert receipt['value'] == {'commit': source, 'branch': 'review', 'dirty': False}
    assert receipt['publication'] == {'commit': source, 'branch': 'review'} and receipt['cleanup'] == {'removed': True}
    assert base != source and git(remote, 'rev-parse', 'refs/heads/main') == base and git(remote, 'rev-parse', 'refs/heads/review') == source
    assert git(remote, 'show', 'review:parcel.txt') == 'ready for review' and not (root / 'checkout').exists()
    print(json.dumps({'version': checked('--version'), 'git': git(root, '--version'), 'base': base, 'source': source,
                      'failed': failed, 'retry': succeeded, 'result': receipt}, indent=2))


if __name__ == '__main__':
    if len(sys.argv) == 2:
        with tempfile.TemporaryDirectory(prefix='special-git-') as directory:
            qualify(str(Path(sys.argv[1]).resolve(strict=True)), directory)
    else:
        print(json.dumps(backend(sys.argv[1], sys.argv[2:])))
