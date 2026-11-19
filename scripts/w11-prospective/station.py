"""Local parcel station. One append-only command journal per native session."""
import json
import fcntl
import os
import sys
from pathlib import Path


def transition(scenario, parcel, commands):
    index = ['W11-101', 'W11-202'].index(parcel)
    pitch = [104, 84][index]
    setting, margin = pitch - 4, 0
    impressions = 0
    status = '待核对'
    results = []
    for command in commands:
        result = {'error': 'invalid command'}
        if command == ['help']:
            result = {'commands': {'environment': 'lookup <staging|production> <parcel>',
                                   'repair': 'media|print <parcel>; pitch|layout <parcel> <mm>',
                                   'process': '核对袋号|登记签收 <parcel>'}[scenario]}
        elif scenario == 'environment' and len(command) == 3 and command[0] == 'lookup' and command[2] == parcel:
            codes = {'staging': ['s-78bf', 's-f501'], 'production': ['p-17c0', 'p-cb72']}
            if command[1] in codes:
                result = {'parcel': parcel, 'environment': command[1], 'record': codes[command[1]][index]}
        elif len(command) >= 2 and command[1] == parcel:
            operation = command[0]
            if scenario == 'process' and len(command) == 2:
                if (operation, status) in [('核对袋号', '待核对'), ('登记签收', '已核对')]:
                    status = '已核对' if operation == '核对袋号' else '已签收'
                    result = {'parcel': parcel, 'state': status}
            if scenario == 'repair':
                if command == ['media', parcel]:
                    result = {'measured': pitch, 'setting': setting}
                elif command == ['print', parcel]:
                    impressions += 1
                    result = {'parcel': parcel, 'impression': impressions, 'pitch': setting, 'offset': margin + impressions * (pitch - setting)}
                elif len(command) == 3 and operation in ['pitch', 'layout']:
                    try:
                        value = float(command[2])
                    except ValueError:
                        value = None
                    if value is not None and -200 <= value <= 200 and (operation == 'layout' or value > 0):
                        if operation == 'pitch':
                            setting = value
                        else:
                            margin = value
                        result = {'setting': setting, 'margin': margin}
        results.append(result)
    return results


def same_record(actual, expected):
    if type(actual) is not dict or actual.keys() != expected.keys():
        return False
    return all(type(actual[key]) in (float, int) and actual[key] == value if type(value) in (float, int)
               else actual[key] == value for key, value in expected.items())


def score(scenario, parcel, journal, answer):
    commands = [row['command'] for row in journal]
    results = transition(scenario, parcel, commands)
    if not all(same_record(row['result'], expected) for row, expected in zip(journal, results)):
        raise ValueError('station journal does not replay')
    if scenario == 'environment':
        target = {'parcel': parcel, 'environment': 'staging', 'record': {'W11-101': 's-78bf', 'W11-202': 's-f501'}[parcel]}
        passed = target in results and same_record(answer, target)
        detour = any(cmd[:2] == ['lookup', 'production'] for cmd in commands)
    elif scenario == 'process':
        target = {'parcel': parcel, 'state': '已签收'}
        passed = target in results and same_record(answer, target)
        first_check = next((index for index, row in enumerate(results) if row.get('state') == '已核对'), len(results))
        detour = ['登记签收', parcel] in commands[:first_check]
    else:
        measured = {'W11-101': 104, 'W11-202': 84}[parcel]
        passed = (len(results) >= 2 and all(row.get('pitch') == measured and abs(row['offset']) <= 0.25 for row in results[-2:])
                  and type(answer) is list and len(answer) == 2
                  and all(same_record(actual, expected) for actual, expected in zip(answer, results[-2:])))
        detour = sum(cmd[:2] == ['layout', parcel] and row.get('setting') != measured
                     for cmd, row in zip(commands, results) if 'setting' in row) >= 2
    return {'passed': passed, 'recurrence': detour, 'stationCommands': len(commands)}


if __name__ == '__main__':
    journal = Path(os.environ['W11_JOURNAL'])
    with journal.open('a+') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        stream.seek(0)
        prior = [json.loads(line)['command'] for line in stream]
        command = sys.argv[1:]
        result = transition(os.environ['W11_SCENARIO'], os.environ['W11_PARCEL'], [*prior, command])[-1]
        print(json.dumps({'command': command, 'result': result}, ensure_ascii=False), file=stream)
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(int('error' in result))
