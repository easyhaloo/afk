"""Recheck a retained W05 Agent comparison against the checked-in receipt."""

import argparse
from hashlib import sha256
import json
from pathlib import Path
from uuid import UUID


def lines(data):
    return [json.loads(line) for line in data.decode('utf-8').splitlines()]


def digest(path):
    return sha256(path.read_bytes()).hexdigest()


def blocks(rows):
    return [(row['uuid'], block) for row in rows
            if isinstance(content := row.get('message', {}).get('content'), list)
            for block in content if block['type'] in {'text', 'tool_use', 'tool_result'}]


def matches_answer(answer, expected):
    try:
        return json.loads(answer) == expected
    except json.JSONDecodeError:
        return False


def verify(arm, case, folder, frozen, pinned):
    launch_bytes = (folder / 'launch.json').read_bytes()
    stream_bytes = (folder / 'events.jsonl').read_bytes()
    launch_digest = sha256(launch_bytes).hexdigest()
    stream_digest = sha256(stream_bytes).hexdigest()
    assert launch_digest == pinned['launchSha256'], 'launch digest'
    assert stream_digest == pinned['streamSha256'], 'stream digest'
    launch = json.loads(launch_bytes)
    assert (launch['arm'], launch['id'], launch['exit']) == (arm, case['checkId'], 0), 'launch'
    session = launch['session']
    assert str(UUID(session)) == session, 'session ID'
    native_path, = folder.glob(f'profile/projects/*/{session}.jsonl')
    native_bytes = native_path.read_bytes()
    trace_digest = sha256(native_bytes).hexdigest()
    assert trace_digest == pinned['traceSha256'], 'native trace digest'
    stream, native = lines(stream_bytes), lines(native_bytes)
    init, = (row for row in stream if row.get('subtype') == 'init')
    terminal, = (row for row in stream if row['type'] == 'result')
    assert {row['session_id'] for row in stream} == {session}, 'stream session'
    assert init['claude_code_version'] == frozen['claude'].split()[0], 'version'
    assert (init['tools'], init['permissionMode'], init['mcp_servers']) == (['Read'], 'dontAsk', []), 'tool policy'
    assert terminal is stream[-1] and terminal['subtype'] == 'success' and not terminal['is_error'], 'terminal'
    work = folder / 'task'
    recorded_work = Path(init['cwd'])
    skill, fixture = recorded_work / 'SKILL.md', recorded_work / 'handoff.json'
    assert digest(work / skill.name) == frozen['digests'][arm], 'skill digest'
    assert digest(work / fixture.name) == frozen['digests']['fixture'], 'fixture digest'
    turns = [row for row in native if row['type'] in {'assistant', 'user'}]
    assert all(row['sessionId'] == session and row['cwd'] == str(recorded_work) and row['version'] == init['claude_code_version'] for row in turns), 'native identity'
    experiment = case['experiment']
    prompt, = (row['message']['content'] for row in turns if isinstance(row['message']['content'], str))
    expected_prompt = (f'First call Read on {skill} by itself and wait for that result. After receiving the skill text, '
                       f'follow it for the unchanged input below. The handoff fixture is at {fixture}.\n\n' + experiment['input'])
    assert prompt == expected_prompt, 'input'
    trace = blocks(stream)
    assert trace == blocks(turns), 'stream and native blocks'
    uses = {}
    results = {}
    for index, (_, block) in enumerate(trace):
        if block['type'] == 'tool_use':
            assert block['name'] == 'Read' and block['id'] not in uses, 'tool authorization'
            path = Path(block['input']['file_path'])
            assert path in {skill, fixture}, 'tool scope'
            uses[block['id']] = index, path
        if block['type'] == 'tool_result':
            key = block['tool_use_id']
            assert key in uses and key not in results and not block.get('is_error'), 'tool result binding'
            use_index, path = uses[key]
            assert use_index < index, 'tool result order'
            text = (work / path.name).read_text()
            numbered = '\n'.join(f'{n}\t{line}' for n, line in enumerate(text.split('\n'), 1))
            assert block['content'] == numbered, 'tool result bytes'
            results[key] = index
    assert set(uses) == set(results) and not terminal['permission_denials'], 'all tool attempts represented'
    skill_ids = [key for key, (_, path) in uses.items() if path == skill]
    reads = [index for index, path in uses.values() if path == fixture]
    assert len(skill_ids) == 1 and all(results[skill_ids[0]] < index for index in reads), 'skill load preceding business reads'
    assert trace[-1][1]['type'] == 'text' and trace[-1][1]['text'] == terminal['result'], 'terminal answer binding'
    expected = next(item['expected'] for item in experiment['assertions'] if item['id'] == 'answer')
    checks = {'reads': len(reads) == len(experiment['skillTrace']['reads']),
              'answer': matches_answer(terminal['result'], expected)}
    return ({'arm': arm, 'id': case['checkId'], 'traceSha256': trace_digest,
             'launchSha256': launch_digest, 'streamSha256': stream_digest, 'businessReads': len(reads),
             'checks': checks, 'status': 'pass' if all(checks.values()) else 'fail'},
            (session, init['model'], launch['routeSha256']))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('evidence', type=Path, help='retained ordered comparison directory')
    parser.add_argument('--round', choices=['retroCandidate', 'previousAmendment'], default='retroCandidate')
    args = parser.parse_args()
    if not __debug__:
        parser.exit(2, 'Run the verifier with Python assertions enabled.\n')
    stage = args.evidence
    reference = Path(__file__).resolve().parent
    where = 'comparison'
    try:
        receipt = json.loads((reference / 'agent-comparison.receipt.json').read_text())
        pinned = receipt[args.round]
        frozen_path = stage / 'frozen.json'
        assert digest(frozen_path) == pinned['frozenSha256'], 'frozen cases digest'
        assert digest(stage / 'replay-ordered.py') == pinned['launcherSha256'], 'launcher digest'
        frozen = json.loads(frozen_path.read_text())
        assert frozen['claude'] == receipt['agent'] and frozen['policy'] == receipt['policy'], 'frozen policy'
        assert frozen['digests'] == pinned['digests'], 'frozen artifacts'
        assert digest(reference / 'handoff.json') == pinned['digests']['fixture'], 'repository fixture digest'
        if args.round == 'retroCandidate':
            assert digest(reference / 'retro-candidate.skill.md') == pinned['digests']['proposed'], 'repository skill digest'
        arms = ('original', 'proposed')
        cases = [(arm, case) for arm in arms for case in frozen['cases']]
        assert len(cases) == len(pinned['cases']) == 6, 'comparison size'
        rows, identities = [], []
        for (arm, case), pinned_case in zip(cases, pinned['cases']):
            where = f"{arm}-{case['checkId']}"
            row, identity = verify(arm, case, stage / f'ordered-{where}', frozen, pinned_case)
            assert row == pinned_case, 'case result differs from receipt'
            rows.append(row)
            identities.append(identity)
        where = 'comparison'
        sessions, models, routes = map(set, zip(*identities))
        assert len(sessions) == 6 and len(models) == len(routes) == 1, 'session isolation and route parity'
        scores = {arm: sum(row['arm'] == arm and row['status'] == 'pass' for row in rows) for arm in arms}
        verdict = 'pass' if scores['proposed'] == 3 and scores['original'] < 3 else 'fail'
        assert scores == pinned['scores'] and verdict == pinned['verdict'], 'comparison result differs from receipt'
    except AssertionError as error:
        parser.exit(1, f'W05 verification blocked at {where}: {error}\n')
    except (OSError, ValueError, KeyError, TypeError, IndexError, AttributeError):
        parser.exit(1, f'W05 verification blocked at {where}: missing or malformed evidence\n')
    print(json.dumps({'round': args.round, 'verifiedCases': len(rows), 'scores': scores, 'verdict': verdict}))


if __name__ == '__main__':
    main()
