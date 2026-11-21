#!/usr/bin/env python3
import json
import subprocess
import sys
from pathlib import Path


def git(directory, *args):
    return subprocess.check_output(['git', '-C', directory, *args], text=True, timeout=10).strip()


def operate(root, operation, request):
    name = request['repository']['url']
    lock = Path(json.loads((root / 'locks.json').read_text())[name])
    claim = json.loads((lock / 'claim.json').read_text())['claimId']
    run = request.get('runId') or request['workspaceId'].removeprefix(name + '-')
    work = root / 'managed' / (name + '@' + run)
    store = root / 'seed' / name
    with (root / 'operations.jsonl').open('a') as journal:
        print(json.dumps(dict(operation=operation, name=name, path=str(work), claim=claim)), file=journal)
    if operation == 'prepare':
        git(store, 'fetch', 'origin')
        git(store, 'worktree', 'add', '--detach', work, 'origin/main')
    if operation == 'checkout':
        if (root / 'fail-checkout').exists():
            sys.exit(3)
        git(work, 'switch', '-c', request['branch'], 'origin/' + request.get('ref', 'main'))
    state = dict(commit=git(work, 'rev-parse', 'HEAD'), branch=git(work, 'rev-parse', '--abbrev-ref', 'HEAD'),
                 dirty=bool(git(work, 'status', '--porcelain', '--ignored', '--untracked-files=all')))
    if operation in ('prepare', 'checkout'):
        return dict(id=name + '-' + run, runId=run, repository=request['repository'], snapshot=state)
    if operation == 'snapshot':
        return state
    assert not state['dirty'] and (state['branch'], state['commit']) == (request['expectedBranch'], request['expectedCommit'])
    if operation == 'publish':
        assert request['merge'] is False and state['branch'] != 'main'
        git(work, 'push', 'origin', state['commit'] + ':refs/heads/' + state['branch'])
        return state
    assert operation == 'cleanup'
    git(store, 'worktree', 'remove', work)
    return dict(removed=not work.exists())


if __name__ == '__main__':
    assert sys.argv[2:] == ['--json']
    print(json.dumps(operate(Path(__file__).resolve().parent, sys.argv[1], json.load(sys.stdin))))
