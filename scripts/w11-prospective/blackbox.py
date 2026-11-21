"""Exercise freeze/run/replay as subprocesses against disposable synthetic inputs."""
import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import unittest
from contextlib import closing
from pathlib import Path

from test_protocol import QueueTest


AGENT = '''import json, os, subprocess, sys, uuid
if '--version' in sys.argv:
    print('blackbox fixture')
    sys.exit()
session = str(uuid.uuid4())
def emit(kind, **fields):
    print(json.dumps(dict(type=kind, session_id=session, **fields)))
emit('system', subtype='init', model='claude-sonnet-4-6', tools=['Bash'], mcp_servers=[], permissionMode='dontAsk')
if mixed:
    print(json.dumps(dict(type='assistant', session_id='second-session', message=dict(content=[dict(type='text', text='fixture')]))))
parcel = os.environ['W11_PARCEL']
for step, action in enumerate(['登记签收','核对袋号','登记签收'], 1):
    tool = 'call-'+str(step)
    command = ['python3','station.py',action,parcel]
    emit('assistant', message=dict(content=[dict(type='tool_use', id=tool, name='Bash', input=dict(command=' '.join(command)))]))
    call = subprocess.run(command, capture_output=True, text=True, check=False)
    emit('user', message=dict(content=[dict(type='tool_result', tool_use_id=tool, is_error=bool(call.returncode), content=call.stdout)]))
lines = sys.argv[sys.argv.index('--system-prompt')+1].splitlines()
claim = None if len(lines)==1 else dict(origin=lines[-2], quote=lines[-1], steps=[1 if lines[-1]=='processold' else 3])
emit('result', subtype='success', total_cost_usd=0.01, result=json.dumps(dict(answer=json.loads(call.stdout), adoption=claim)))
'''


def exercise(runner, case, legacy):
    fixture = QueueTest()
    fixture.setUp()
    try:
        fixture.group('process', linked=case != 'snapshot')
        spec = fixture.config
        for arm in ('old','new'):
            spec['groups']['process'][arm]['adoption']['commands'] = [['登记签收','{parcel}']]
        Path(spec['agent']).write_text(f'#!{sys.executable}\nmixed = {case == "mixed"}\n'+AGENT)
        fixture.spec.write_text(json.dumps(spec))
        queue = fixture.root
        check = unittest.TestCase()

        def invoke(program, *args, error=None):
            call = subprocess.run([sys.executable,'-B',str(program),*map(str,args)], cwd=fixture.base,
                                  env={'PATH':os.environ['PATH'],'HOME':str(fixture.base)}, capture_output=True, text=True, timeout=60)
            if error is None:
                check.assertEqual(call.returncode, 0, call.stderr)
            else:
                check.assertNotEqual(call.returncode, 0)
                check.assertIn(error, call.stderr)
            return call.stdout

        if case == 'snapshot':
            invoke(runner, 'freeze', fixture.spec, fixture.base/'unrelated', error='successive publications')
            old_key = json.loads((fixture.base/'processold/publication.json').read_bytes())['key']
            with closing(sqlite3.connect(fixture.base/'processnew/.afk/learning/candidates.sqlite')) as db, db:
                pack = json.loads(db.execute("select payload from learning_ledger where kind='snapshot'").fetchone()[0])
                entry = pack['entries'][0]
                check.assertIn('W11 supersedes '+'a'*64, entry['content'])
                entry['content'] = entry['content'].replace('a'*64, old_key)
                db.execute("update learning_ledger set payload=? where kind='snapshot'", (json.dumps(pack),))
            invoke(runner, 'freeze', fixture.spec, queue, error=None if legacy else 'evidence pack digest mismatch')
            return {'unrelated':'rejected','alteredBody':'admitted' if legacy else 'rejected'}

        invoke(runner, 'freeze', fixture.spec, queue)
        blocked = case == 'mixed' and not legacy
        invoke(runner, 'run', queue, 'process', 1, 225, error='unresolved spend: unknown' if blocked else None)
        before = invoke(runner, 'replay', queue)
        moved = fixture.base/'relocated queue'
        queue.rename(moved)
        frozen = moved/'frozen/protocol.py'
        if blocked:
            invoke(frozen, 'run', moved, 'process', 2, 225, error='prior attempt has unresolved spend')
        for source in ('processold','processnew','installed'):
            shutil.rmtree(fixture.base/source)
        Path(spec['agent']).unlink()
        check.assertEqual(invoke(frozen, 'replay', moved), before)
        report = json.loads(before)
        rows = {row['slot']:row for row in report['rows']}
        seats = [rows['process-1-'+arm] for arm in ('none','old','new')]
        directories = sorted(path.name for path in (moved/'attempts').iterdir())
        check.assertEqual(directories, sorted(seat['slot'] for seat in (seats[:1] if blocked else seats)))
        if case == 'mixed':
            check.assertEqual(report['reservedCents'], 75 if blocked else 225)
            check.assertEqual(seats[0]['spend'], 'unknown' if blocked else 'within-cap')
            if blocked:
                check.assertEqual([seat['status'] for seat in seats[1:]], ['pending','pending'])
                check.assertIsNone(seats[0]['reportedUSD'])
            return {'attempts':len(directories),'reservedCents':report['reservedCents'],'spend':seats[0]['spend'],'relocatedReplay':'identical'}
        for seat in seats:
            check.assertEqual((seat['trace'],seat['checker']['passed'],seat['status']), ('verified',True,'passed'))
        failed, retry = seats[1:]
        check.assertEqual((failed['adoption'],failed['adoptionToolIds']), ('observed',['call-1']) if legacy else ('unobserved',[]))
        check.assertEqual((retry['adoption'],retry['adoptionToolIds']), ('observed',['call-3']))
        return {'failedCitation':failed['adoption'],'successfulRetry':retry['adoption'],'relocatedReplay':'identical'}
    finally:
        fixture.doCleanups()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runner', type=Path, default=Path(__file__).with_name('protocol.py'))
    parser.add_argument('--expect', choices=['candidate','3c338502'], default='candidate')
    options = parser.parse_args()
    print(json.dumps({case:exercise(options.runner.resolve(), case, options.expect=='3c338502')
                      for case in ('snapshot','mixed','adoption')}, indent=2))
