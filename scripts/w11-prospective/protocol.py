"""Prospective W11: template | freeze SPEC NEW_DIR | run DIR SCENARIO REPEAT CENTS | replay DIR | check-live DIR."""
import fcntl
import base64
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import tempfile
import uuid
import re
from contextlib import closing
from decimal import Decimal
from pathlib import Path

sys.dont_write_bytecode = True
from station import score

HERE = Path(__file__).resolve().parent
SCOPE = 'github:w11/parcel'
MODEL = 'claude-sonnet-4-6'
PROMPTS = {'environment': '在 staging 快照中定位指定包裹的运行日志并返回对应记录。',
           'repair': '修复指定面单的纵向偏移，使用同一标签验证修复结果。',
           'process': '按 staging 的非自提退件流程办理指定包裹的交接，给出签收记录。'}
SYSTEM = ('只串行执行 python3 station.py 参数，可用 help 查看操作。最终仅返回 JSON 对象，answer 填站点原始记录'
          '（修复题填同一面单最后连续两次试印记录的数组）。adoption 默认 null；若使用所附资料，填对象，'
          'origin 为其来源，quote 为实际采用的原文，steps 为对应站点调用序号数组（从 1 计，含 help）。')
ARMS = ('none', 'old', 'new')
PARAMETERS = ('W11-101', 'W11-202')
KINDS = {'environment': 'fact', 'repair': 'lesson', 'process': 'process'}
FILES = ('stdout.jsonl', 'stderr', 'exit.json', 'argv.json', 'journal.jsonl', 'workspace/station.py',
         'gather/stdout.json', 'gather/command.json', 'gather/stderr', 'gather/health.json', 'reservation.json')
POSITIVE_FILES = tuple('gather/positive/'+name for name in ('stdout.json', 'command.json', 'stderr', 'health.json'))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def digest(value):
    return sha(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode())


def read(file):
    return json.loads(file.read_bytes())


def unique_keys(pairs):
    obj = dict(pairs)
    require(len(obj) == len(pairs), 'ambiguous JSON record')
    return obj


def save(file, value):
    with file.open('x') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write('\n')


def manifest(directory):
    return {str(path.relative_to(directory)): sha(path.read_bytes()) for path in sorted(directory.rglob('*')) if path.is_file()}


def package_digest(cli):
    entry = Path(cli).resolve(strict=True)
    root = entry.parent.parent
    require(entry.parent.name == 'dist' and all((root/name).is_file() for name in ('release.json', 'package.json'))
            and (root/'node_modules').is_dir(), 'installed AFK package required')
    files = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            require(path.resolve(strict=True).is_relative_to(root), 'external installed dependency')
            value = ['link', os.readlink(path)]
        elif path.is_file():
            value = ['file', sha(path.read_bytes())]
        else:
            require(path.is_dir(), 'unsupported installed entry')
            continue
        files[str(path.relative_to(root))] = value
    return digest(files)


def evidence_predecessors(pack, expected_digest, assertions):
    body = {key: value for key, value in pack.items() if key != 'digest'}
    require(set(body) == {'version','completeness','sources','entries','warnings'} and type(body['version']) is int
            and body['version'] == 1 and body['completeness'] == 'complete' and body['warnings'] == [] and body['entries'],
            'complete product evidence pack required')
    require(digest(body) == pack['digest'] == expected_digest, 'evidence pack digest mismatch')
    sources = {source['id']: source for source in pack['sources']}
    require(len(sources) == len(pack['sources']), 'duplicate evidence source')
    counts = dict.fromkeys(sources, 0)
    seen = set()
    references = {(ref['id'], ref['digest'], ref['locator']) for assertion in assertions for ref in assertion['evidence']}
    predecessors = set()
    for entry in pack['entries']:
        position, ref = entry['position'], entry['ref']
        source_id = position['sourceId']
        require(source_id in sources, 'unknown evidence source')
        source = sources[source_id]
        counts[source_id] += 1
        index = counts[source_id]
        require(type(position['messageIndex']) is int and position['messageIndex'] == index, 'evidence message index')
        checksum = digest(dict(content=entry['content'], position=position, completeness=source['completeness']))
        locator = f'source:{source_id}/messages/{index}'
        require(isinstance(entry['content'], str) and ref['digest'] == checksum and ref['id'] == 'evidence:'+checksum
                and ref['locator'] == locator and checksum not in seen, 'evidence entry digest or locator mismatch')
        seen.add(checksum)
        observed = source['kind'] == 'audit'
        require(source['kind'] in ('audit','journal','session') and ref['completeness'] == source['completeness'] == 'complete'
                and ref['authority'] == ('observed' if observed else 'declared') and ref['kind'] in
                (('message','tool-result') if source['kind'] == 'session' else ('audit',)), 'invalid evidence provenance')
        if observed and (ref['id'], checksum, locator) in references:
            predecessors.update(re.findall(r'W11 supersedes ([0-9a-f]{64})\b', entry['content']))
    for source_id, source in sources.items():
        count = counts[source_id]
        require(count > 0 and type(source['messageCount']) is int and count == source['messageCount'] and
                source.get('range', {'start':1,'end':count}) == {'start':1,'end':count} and
                re.fullmatch(r'[a-f0-9]{64}', source['sourceDigest']), 'incomplete evidence source')
    return predecessors


def audit_edition(directory, query, page, name):
    pub = read(directory/'publication.json')
    grant = read(directory/'grant.json')
    validation = read(directory/'validation.json')
    check = read(directory/'independent-check.json')
    prepared = read(directory/'plan.json')
    require(digest(prepared) == pub['key'] and digest(grant) == prepared['authorizationDigest'] and
            prepared['policyDigest'] == digest(grant['policy']), 'plan or grant digest')
    require(prepared['classification'] == KINDS[name] and prepared['proposal']['targetRef'] == pub['targetRef'], 'scenario or target mismatch')
    require(pub['phase'] == 'committed' and pub['observedDigest'] == pub['targetDigest'], 'publication incomplete')
    require(grant['revoked'] is False and grant['policy']['scope'] == query['scope'] and any(
        item['ref'] == pub['targetRef'] and page in item['paths'] and KINDS[name] in item['kinds'] for item in grant['policy']['targets']), 'grant scope/target')
    require(validation['status'] == 'validated' and validation['validatedVersion'] == pub['candidateVersion'] and
            validation['candidateId'] == pub['candidateId'] == check['binding']['candidateId'] and
            check['binding']['scope'] == query['scope'] and check['binding']['target']['ref'] == pub['targetRef'] and
            check['binding']['executionId'] == validation['executionId'] and
            check['binding']['candidateVersion'] == validation['candidateVersion'] and
            all(check['binding'][key] == pub[key] for key in ('candidateDigest', 'evidenceDigest')), 'independent validation binding')
    require(check['assertions'] and all(row['status'] == 'observed' and row['expected'] == row['actual'] for row in check['assertions']), 'checker assertions')
    require(check['protocol'] == 'learning-validation-v1' and validation['receiptDigest'] == digest(check) and
            pub['validatorVersion'] == check['protocol']+':'+validation['executionId'] and
            check['binding']['target']['scope'] == query['scope'], 'checker receipt digest')
    with closing(sqlite3.connect((directory/'candidates.sqlite').resolve().as_uri()+'?immutable=1', uri=True)) as ledger:
        def records(kind):
            return [json.loads(row[0]) for row in ledger.execute('select payload from learning_ledger where kind=?', (kind,))]
        require(pub in records('publication'), 'publication absent from product ledger')
        record, = [row for row in records('validation') if row['passed'] and row['validatedVersion'] == pub['candidateVersion'] and all(
            row[key] == pub[key] for key in ('candidateId','candidateDigest','validatorVersion','evidenceDigest'))
                  and row['candidateVersion'] == validation['candidateVersion']]
        chunks = record['results']
        require(chunks and all(item.startswith('json-base64-v1:') for item in chunks), 'checker envelope encoding')
        envelope = json.loads(base64.b64decode(''.join(item.split(':',1)[1] for item in chunks), validate=True))
        require(envelope == {'report': check, 'receiptDigest': digest(check)}, 'independent report differs from ledger')
        snapshots = ledger.execute("select payload from learning_ledger where kind='snapshot' and key=?", (pub['evidenceDigest'],)).fetchall()
        require(len(snapshots) == 1, 'missing or ambiguous product snapshot')
        predecessors = evidence_predecessors(json.loads(snapshots[0][0], object_pairs_hook=unique_keys), pub['evidenceDigest'], check['assertions'])
    require(all(prepared[key] == pub[key] for key in ('candidateId','candidateVersion','candidateDigest','evidenceDigest','targetRef','validatorVersion')), 'prepared publication binding')
    changes = prepared['plan']['changes']
    require(pub['originalDigest'] == digest([{'path': item['path'], 'sha256': item['expected_sha256']} for item in changes]) and
            pub['targetDigest'] == digest([{'path': item['path'], 'sha256': sha(item['content'].encode())} for item in changes]), 'publication byte digests')
    change = changes[0]
    require(change['path'] == page, 'target page mismatch')
    return dict(origin=f"knowledge:{pub['key']}; target:{pub['targetRef']}", key=pub['key'], target=pub['targetRef'],
                candidate=pub['candidateId'], version=pub['candidateVersion'], execution=validation['executionId'],
                page=page, previous=change['expected_sha256'], predecessors=sorted(predecessors), content=sha(change['content'].encode()))


def check_pair(old, new):
    require(old['key'] != new['key'] and old['execution'] != new['execution'] and
            (old['candidate'], old['version']) != (new['candidate'], new['version']) and
            old['target'] == new['target'] and old['content'] != new['content'] and
            ((old['page'] == new['page'] and old['content'] == new['previous']) or new['predecessors'] == [old['key']]),
            'expected separately validated successive publications of one logical target')


def gather(config, queryfile, edition, expected, directory):
    directory.mkdir()
    profile = directory/'home'
    profile.mkdir()
    if edition:
        source = edition/'profile'
        plan = read(edition/'plan.json')
        authority = Path(plan['authorizationFile'])
        require(authority.is_absolute() and authority.is_file(), 'live grant unavailable')
        live = read(authority)
        require(live.get('revoked') is False, 'live grant revoked')
        require(digest(live) == plan['authorizationDigest'], 'live grant changed')
        target = profile/'.afk'
        target.mkdir()
        shutil.copyfile(source/'plugins.yml', target/'plugins.yml')
        if expected:
            if (edition/'source-home.json').exists():
                profile = Path(read(edition/'source-home.json'))
                active = profile/'.afk'
                require(active.is_dir(), 'source profile unavailable')
                require(profile.resolve() == profile and profile != Path.home().resolve() and
                        all((active/path).is_file() and sha((active/path).read_bytes()) == checksum
                            for path, checksum in manifest(source).items() if not path.endswith(('-wal','-shm'))) and
                        not any(path.stat().st_size for path in (active/'learning').glob('*-wal')), 'source profile drift')
            else:
                shutil.copytree(source, target, dirs_exist_ok=True)
        else:
            positive = gather(config, queryfile, edition, read(edition.parent/'bindings.json')['old'], directory/'positive')
            if (source/'plugins').is_dir():
                shutil.copytree(source/'plugins', target/'plugins')
            (target/'learning').mkdir()
            database = target/'learning/candidates.sqlite'
            shutil.copyfile(edition/'candidates.sqlite', database)
            with closing(sqlite3.connect(database)) as ledger, ledger:
                ledger.execute('delete from learning_ledger')
                require(ledger.execute('pragma quick_check').fetchall() == [('ok',)] and
                        ledger.execute('select count(*) from learning_ledger').fetchone() == (0,), 'empty ledger unhealthy')
    args = [config['node'], config['cli'], 'plugin', 'invoke', 'context.provider', 'context.knowledge', 'gather', '--input', str(queryfile), '--json']
    result = subprocess.run(args, cwd=profile, env={'HOME': str(profile), 'USERPROFILE':str(profile),
                            'AFK_EVENT_STORE_DIR':str(profile/'events'), 'PATH': os.environ['PATH']}, capture_output=True, timeout=60)
    (directory/'stdout.json').write_bytes(result.stdout)
    (directory/'stderr').write_bytes(result.stderr)
    save(directory/'command.json', {'argv': args, 'exit': result.returncode})
    result.check_returncode()
    fragments = json.loads(result.stdout)
    require([item['origin'] for item in fragments] == ([expected['origin']] if expected else []), 'assigned publication not uniquely recalled')
    if expected:
        require(sha(fragments[0]['content'].encode()) == expected['content'], 'published page differs from recall')
    save(directory/'health.json', dict(query=digest(read(queryfile)), plugins=sha((source/'plugins.yml').read_bytes()),
                                      positive=digest(fragments if expected else positive), emptyLedger=not bool(expected)))
    return fragments


def template():
    return dict(protocol='w11-prospective-v2', cli='/absolute/path/dist/index.js', agent='/absolute/path/claude',
                node=shutil.which('node'), perSlotCents=75, totalCents=1350, groups={name: None for name in PROMPTS})


def freeze(spec, root):
    config = read(spec)
    require(config['protocol'] == template()['protocol'] and set(config['groups']) == set(PROMPTS), 'queue schema')
    require(type(config['perSlotCents']) is int and 0 < config['perSlotCents'] <= 75 and
            type(config['totalCents']) is int and 0 <= config['totalCents'] <= 1350, 'budget in integer cents')
    root.mkdir()
    frozen = root/'frozen'
    frozen.mkdir()
    save(frozen/'config.json', config)
    for name in ['protocol.py', 'station.py']:
        shutil.copyfile(HERE/name, frozen/name)
    tools = {name: sha(Path(config[name]).read_bytes()) for name in ['cli', 'node', 'agent']}
    tools['installedPackage'] = package_digest(config['cli'])
    home = root/'version-home'
    home.mkdir()
    for name, args in [('afkVersion', [config['node'], config['cli']]), ('agentVersion', [config['agent']])]:
        tools[name] = subprocess.check_output([*args, '--version'], cwd=home, env={'HOME': str(home),'PATH': os.environ['PATH']}, text=True, timeout=30).strip()
    tools['python'] = sys.version
    tools['stationPython'] = sha(Path(shutil.which('python3')).read_bytes())
    tools['endpointHash'] = sha(os.environ.get('ANTHROPIC_BASE_URL','').encode())
    save(frozen/'tools.json', tools)
    for name, group in config['groups'].items():
        if group is None:
            continue
        target = frozen/name
        target.mkdir()
        query = group['query']
        require(query['scope'] == SCOPE and query['prompt'] == PROMPTS[name] and 2 <= query.get('limit', 5) <= 20 and
                query['applicability']['environment'] == 'staging' and query['target']['project'] == SCOPE, 'frozen scope, prompt and applicability')
        save(target/'query.json', query)
        bindings = {}
        for arm in ('old','new'):
            edition = group[arm]
            directory = target/arm
            directory.mkdir()
            source = Path(edition['evidence'])
            profile = Path(edition['profile']).resolve()/'.afk'
            require(profile != Path.home()/'.afk' and not any(path.is_symlink() for path in [profile, *profile.rglob('*')]), 'explicit synthetic snapshot required')
            ledger = profile/'learning/candidates.sqlite'
            require(not Path(str(ledger)+'-wal').exists() or Path(str(ledger)+'-wal').stat().st_size == 0, 'checkpoint snapshot first')
            for file in ['publication.json','validation.json','grant.json','independent-check.json']:
                shutil.copyfile(source/file, directory/file)
            publication = read(directory/'publication.json')
            require(len(publication['key']) == 64 and all(char in '0123456789abcdef' for char in publication['key']), 'publication key')
            (directory/'profile').mkdir()
            if edition.get('sourceHome') is True:
                require(profile.parent.is_relative_to(spec.resolve().parent) and profile.parent != spec.resolve().parent,
                        'live product HOME must be a dedicated synthetic child of the spec directory')
                save(directory/'source-home.json', str(profile.parent))
            shutil.copyfile(profile/'plugins.yml', directory/'profile/plugins.yml')
            shutil.copytree(profile/'learning', directory/'profile/learning')
            if (profile/'plugins').is_dir():
                shutil.copytree(profile/'plugins', directory/'profile/plugins')
            shutil.copyfile(directory/'profile/learning/candidates.sqlite', directory/'candidates.sqlite')
            shutil.copyfile(ledger.parent/'publications'/publication['key']/'plan.json', directory/'plan.json')
            bindings[arm] = audit_edition(directory, query, edition['page'], name)
        check_pair(bindings['old'], bindings['new'])
        require(bindings['old']['target'] == group['targetRef'], 'scenario publication target')
        save(target/'bindings.json', bindings)
        for arm in ARMS:
            selected = gather(config, target/'query.json', target/('old' if arm == 'none' else arm), bindings.get(arm), root/f'preflight-{name}-{arm}')
            save(target/f'{arm}-gather.json', selected)
            shutil.copyfile(root/f'preflight-{name}-{arm}'/'health.json', target/f'{arm}-health.json')
            rule = group.get(arm, {}).get('adoption')
            if rule is not None:
                require(isinstance(rule.get('quote'), str) and rule['quote'] and rule['quote'] in selected[0]['content'] and
                        isinstance(rule.get('commands'), list) and rule['commands'] and all(isinstance(cmd, list) and cmd and
                        cmd != ['help'] and all(isinstance(arg, str) for arg in cmd) for cmd in rule['commands']), 'invalid adoption rule')
    slots = [f'{name}-{repeat}-{arm}' for name in PROMPTS for repeat in [1,2] for arm in (ARMS if repeat == 1 else ARMS[::-1])]
    save(frozen/'schedule.json', slots)
    save(root/'lock.json', manifest(frozen))
    print(sha((root/'lock.json').read_bytes()))


def verify(root):
    frozen = root/'frozen'
    require(manifest(frozen) == read(root/'lock.json'), 'frozen inputs changed')
    for name in ['protocol.py', 'station.py']:
        require((HERE/name).read_bytes() == (frozen/name).read_bytes(), 'use frozen runner and checker')
    return read(frozen/'config.json')


def arguments(config, name, parameter, fragments):
    prompt = SYSTEM + ('\n\n'+fragments[0]['origin']+'\n'+fragments[0]['content'] if fragments else '')
    return [config['agent'], '--print', '--safe-mode', '--restricted', '--strict-mcp-config', '--no-session-persistence',
            '--disable-slash-commands','--tools','Bash','--allowedTools','Bash(python3 station.py *)','--permission-mode','dontAsk',
            '--model', MODEL,'--effort','low','--max-budget-usd', f"{config['perSlotCents']/100:.2f}",
            '--output-format','stream-json','--verbose','--system-prompt',prompt,'--',PROMPTS[name]+'\n参数：'+parameter]


def verify_tools(config, frozen):
    tools = read(frozen/'tools.json')
    require(package_digest(config['cli']) == tools['installedPackage'], 'installed package drift')
    require(all(sha(Path(config[key]).read_bytes()) == tools[key] for key in ['cli','node','agent']) and sys.version == tools['python'], 'tool drift')
    require(tools['stationPython'] == sha(Path(shutil.which('python3')).read_bytes()) and
            tools['endpointHash'] == sha(os.environ.get('ANTHROPIC_BASE_URL','').encode()), 'station or provider drift')


def live_reason(error):
    if isinstance(error, ValueError) and str(error) in ('live grant revoked', 'live grant changed', 'live grant unavailable',
            'source profile unavailable', 'source profile drift', 'installed package drift', 'tool drift', 'station or provider drift',
            'assigned publication not uniquely recalled', 'published page differs from recall'):
        return str(error)
    return 'live dependency unavailable'


def check_live(root):
    config = verify(root)
    frozen = root/'frozen'
    report = {'archive': 'verified', 'modelCalls': 0, 'groups': {}}
    replay(root)
    try:
        verify_tools(config, frozen)
        report['tools'] = 'verified'
    except (ValueError, OSError, RuntimeError) as error:
        report['tools'] = live_reason(error)
    with tempfile.TemporaryDirectory() as scratch:
        for name, group in config['groups'].items():
            states = report['groups'][name] = {}
            for arm in ARMS:
                if group is None:
                    states[arm] = 'missing-publications'
                    continue
                if report['tools'] != 'verified':
                    states[arm] = 'unavailable'
                    continue
                folder = frozen/name
                try:
                    selection = gather(config, folder/'query.json', folder/('old' if arm == 'none' else arm),
                                       read(folder/'bindings.json').get(arm), Path(scratch)/(name+arm))
                    require(selection == read(folder/f'{arm}-gather.json'), 'recall drift')
                    states[arm] = 'healthy'
                except (ValueError, OSError, KeyError, sqlite3.Error, subprocess.SubprocessError) as error:
                    states[arm] = live_reason(error)
    return report


def run(root, name, repeat, allowance):
    config = verify(root)
    require(name in PROMPTS and repeat in (1,2) and config['groups'][name], 'group lacks admitted editions')
    frozen = root/'frozen'
    verify_tools(config, frozen)
    slots = [slot for slot in read(frozen/'schedule.json') if slot.startswith(f'{name}-{repeat}-')]
    attempts = root/'attempts'
    attempts.mkdir(exist_ok=True)
    with (root/'run.lock').open('a') as guard:
        fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        pending = [slot for slot in slots if not (attempts/slot).exists()]
        prior = replay(root)['rows']
        require(not any(row['status'] == 'interrupted' or (row['status'] in ('failed','passed') and
                    row['spend'] != 'within-cap') for row in prior), 'prior attempt has unresolved spend')
        cap = config['perSlotCents']
        require(pending and len(pending)*cap <= allowance and (sum('reservation' in row for row in prior)+len(pending))*cap <= config['totalCents'], 'no open slots or insufficient budget')
        for slot in pending:
            arm = slot.split('-')[-1]
            directory = attempts/slot
            directory.mkdir()
            parameter = PARAMETERS[repeat-1]
            try:
                selected = gather(config, frozen/name/'query.json', frozen/name/('old' if arm == 'none' else arm), read(frozen/name/'bindings.json').get(arm), directory/'gather')
                require(selected == read(frozen/name/f'{arm}-gather.json'), 'recall drift')
            except (ValueError, OSError, KeyError, sqlite3.Error, subprocess.SubprocessError) as error:
                save(directory/'prelaunch.json', {'reason': live_reason(error)})
                raise
            workspace = directory/'workspace'
            workspace.mkdir()
            home = directory/'agent-home'
            home.mkdir()
            journal = directory/'journal.jsonl'
            journal.touch()
            shutil.copyfile(frozen/'station.py', workspace/'station.py')
            env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'CLAUDE_CONFIG_DIR': str(home/'.claude'),
                   'W11_JOURNAL': str(journal), 'W11_SCENARIO': name, 'W11_PARCEL': parameter}
            for key in ['ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL']:
                if key in os.environ:
                    env[key] = os.environ[key]
            args = arguments(config, name, parameter, selected)
            save(directory/'argv.json', args)
            save(directory/'reservation.json', dict(slot=slot, capCents=cap, runId=str(uuid.uuid4()), workItemId=f'{SCOPE}#{time.time_ns()//1000}', lock=sha((root/'lock.json').read_bytes())))
            with (directory/'stdout.jsonl').open('xb') as stdout, (directory/'stderr').open('xb') as stderr:
                try:
                    exitcode = subprocess.run(args, cwd=workspace, env=env, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, timeout=180).returncode
                except subprocess.TimeoutExpired:
                    exitcode = 'timeout'
            save(directory/'exit.json', exitcode)
            files = FILES + (POSITIVE_FILES if arm == 'none' else ())
            save(directory/'files.json', {file: sha((directory/file).read_bytes()) for file in files})
            row = next(row for row in replay(root)['rows'] if row['slot'] == slot)
            require(row['spend'] == 'within-cap', 'unresolved spend: '+row['spend'])


def spend_status(cost, cap):
    if cost is None:
        return 'unknown'
    if type(cost) not in (int, Decimal) or not Decimal(cost).is_finite() or cost < 0:
        return 'invalid'
    return 'within-cap' if cost <= Decimal(cap).scaleb(-2) else 'over-cap'


def station_trace(events, session, journal):
    ids = []
    pending = None
    for event in events:
        require(event.get('type') in ('system', 'assistant', 'user', 'result', 'rate_limit_event'), 'unexpected native event')
        for block in event.get('message', {}).get('content', []):
            kind = block.get('type')
            if kind in ('text', 'thinking', 'redacted_thinking'):
                continue
            require(event.get('session_id') == session and session and not event.get('parent_tool_use_id'), 'foreign tool event')
            require(len(ids) < len(journal), 'extra tool event')
            entry = journal[len(ids)]
            if kind == 'tool_use':
                ident = block.get('id')
                require(event['type'] == 'assistant' and pending is None and isinstance(ident, str) and ident and ident not in ids,
                        'duplicate or unordered tool call')
                data = block['input']
                require(block.get('name') == 'Bash' and set(data) <= {'command', 'description', 'timeout', 'run_in_background', 'dangerouslyDisableSandbox'}
                        and data.get('run_in_background', False) is False and data.get('dangerouslyDisableSandbox', False) is False,
                        'tool boundary')
                command = entry['command']
                require(command and all(re.fullmatch(r'[\w.-]+', arg) for arg in command) and
                        data['command'] == ' '.join(['python3', 'station.py', *command]), 'station command mismatch')
                pending = ident
            else:
                require(kind == 'tool_result' and event['type'] == 'user' and pending and block.get('tool_use_id') == pending,
                        'unmatched tool result')
                content = block['content']
                if isinstance(content, list):
                    require(len(content) == 1 and content[0]['type'] == 'text', 'ambiguous tool output')
                    content = content[0]['text']
                failed = 'error' in entry['result']
                require(block.get('is_error', False) is failed, 'station exit mismatch')
                if failed:
                    content = content.removeprefix('Exit code 1\n')
                require(digest(json.loads(content, object_pairs_hook=unique_keys)) == digest(entry['result']), 'station output mismatch')
                ids.append(pending)
                pending = None
    require(not pending and len(ids) == len(journal), 'missing native tool evidence')
    return ids


def adoption_status(fragments, rule, claim, journal, ids, parcel):
    if not fragments:
        return 'inapplicable', []
    if not rule:
        return 'unregistered', []
    if not isinstance(claim, dict) or claim.get('origin') != fragments[0]['origin'] or claim.get('quote') != rule['quote']:
        return 'unobserved', []
    steps = claim.get('steps')
    if not isinstance(steps, list) or not all(type(step) is int and 1 <= step <= len(ids) for step in steps) or steps != sorted(set(steps)):
        return 'unobserved', []
    expected = [[arg.replace('{parcel}', parcel) for arg in cmd] for cmd in rule['commands']]
    cited = [journal[step-1] for step in steps]
    if any('error' in row['result'] for row in cited) or [row['command'] for row in cited] != expected:
        return 'unobserved', []
    return 'observed', [ids[step-1] for step in steps]


def replay(root):
    config = verify(root)
    frozen = root/'frozen'
    for name, group in config['groups'].items():
        if group is None:
            continue
        folder = frozen/name
        bindings = {arm: audit_edition(folder/arm, read(folder/'query.json'), group[arm]['page'], name) for arm in ('old','new')}
        check_pair(bindings['old'], bindings['new'])
        require(bindings == read(folder/'bindings.json'), 'frozen edition identities changed')
        for arm in ARMS:
            fragments = read(folder/f'{arm}-gather.json')
            expected = bindings.get(arm)
            require([(item['origin'],sha(item['content'].encode())) for item in fragments] ==
                    ([(expected['origin'],expected['content'])] if expected else []), 'frozen delivery mismatch')
            source = arm if expected else 'old'
            require(read(folder/f'{arm}-health.json') == dict(query=digest(read(folder/'query.json')),
                    plugins=sha((folder/source/'profile/plugins.yml').read_bytes()), positive=digest(read(folder/f'{source}-gather.json')),
                    emptyLedger=not bool(expected)), 'frozen health mismatch')
    rows = []
    identities = {key: set() for key in ['session','runId','workItemId']}
    for slot in read(frozen/'schedule.json'):
        name, repeat, arm = slot.split('-')
        parameter = PARAMETERS[int(repeat)-1]
        directory = root/'attempts'/slot
        row = dict(slot=slot, parameter=parameter, status='pending' if config['groups'][name] else 'missing-publications')
        rows.append(row)
        if not directory.exists():
            continue
        row['status'] = 'interrupted'
        if (directory/'reservation.json').exists():
            row['reservation'] = read(directory/'reservation.json')
        elif (directory/'prelaunch.json').is_file():
            row.update(status='prelaunch-blocked', reason=read(directory/'prelaunch.json')['reason'], spend='not-launched')
        if not (directory/'files.json').exists():
            continue
        hashes = read(directory/'files.json')
        require(set(hashes) == set(FILES + (POSITIVE_FILES if arm == 'none' else ())), 'incomplete attempt manifest')
        for path, checksum in hashes.items():
            require(sha((directory/path).read_bytes()) == checksum, 'attempt artifacts changed')
        require((directory/'workspace/station.py').read_bytes() == (frozen/'station.py').read_bytes(), 'station drift')
        reservation = read(directory/'reservation.json')
        require(reservation['slot'] == slot and reservation['capCents'] == config['perSlotCents'] and reservation['lock'] == sha((root/'lock.json').read_bytes()), 'reservation binding')
        fragments = read(directory/'gather/stdout.json')
        if arm == 'none':
            require(read(directory/'gather/positive/stdout.json') == read(frozen/name/'old-gather.json') and
                    read(directory/'gather/positive/command.json')['exit'] == 0, 'missing positive control')
        require(read(directory/'gather/health.json') == read(frozen/name/f'{arm}-health.json') and
                read(directory/'gather/command.json')['exit'] == 0, 'attempt health mismatch')
        require(fragments == read(frozen/name/f'{arm}-gather.json') and read(directory/'argv.json') == arguments(config,name,parameter,fragments), 'delivery drift')
        events = []
        costs = []
        valid_stream = True
        for line in (directory/'stdout.jsonl').read_bytes().splitlines():
            try:
                event = json.loads(line, object_pairs_hook=unique_keys)
                require(isinstance(event, dict), 'invalid native event')
                events.append(event)
                if event.get('type') == 'result':
                    costs.append(json.loads(line, parse_float=Decimal).get('total_cost_usd'))
            except ValueError:
                valid_stream = False
        inits = [event for event in events if event.get('type') == 'system' and event.get('subtype') == 'init']
        init = inits[0] if len(inits) == 1 else {}
        result = next((event for event in reversed(events) if event.get('type') == 'result'), {})
        session = init.get('session_id')
        if session:
            require(init['model'] == MODEL and init['tools'] == ['Bash'] and not init['mcp_servers'] and
                    init['permissionMode'] == 'dontAsk', 'native controls/session drift')
        for key, value in [('session',session),('runId',reservation['runId']),('workItemId',reservation['workItemId'])]:
            if value:
                require(value not in identities[key], 'reused '+key)
                identities[key].add(value)
        journal = [json.loads(line) for line in (directory/'journal.jsonl').read_bytes().splitlines()]
        terminal = bool(valid_stream and isinstance(session, str) and session and len(costs) == 1 and events[-1] is result and
                        all(event.get('session_id') == session for event in events if 'session_id' in event or
                            event.get('type') in ('assistant','user','result')) and
                        not any(event.get('type') in ('assistant','user','result') for event in events[:events.index(init)]))
        spend = spend_status(costs[0] if terminal else None, config['perSlotCents'])
        try:
            final = json.loads(result.get('result') or '', object_pairs_hook=unique_keys)
            if type(final) is not dict or set(final) != {'answer','adoption'}:
                final = {}
        except (ValueError, TypeError):
            final = {}
        ids = []
        try:
            require(terminal, 'invalid session stream')
            ids = station_trace(events, session, journal)
            checked = score(name, parameter, journal, final.get('answer'))
            trace = 'verified'
        except (KeyError, ValueError, TypeError, AttributeError, IndexError):
            checked = {'passed': None, 'recurrence': None, 'stationCommands': None}
            trace = 'invalid'
        completed = result.get('subtype') == 'success' and not result.get('is_error') and read(directory/'exit.json') == 0
        passed = bool(trace == 'verified' and spend == 'within-cap' and completed and checked['passed'])
        adoption, cited = ('unassessable', [])
        if trace == 'verified' and completed:
            adoption, cited = adoption_status(fragments, config['groups'][name].get(arm, {}).get('adoption'), final.get('adoption'), journal, ids, parameter)
        usage = result.get('usage', {})
        tokens = [usage.get(key) for key in ('input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens')]
        controls = {key: init.get(key) for key in ('model','claude_code_version','permissionMode','tools','plugins','skills','mcp_servers','output_style')}
        controls['argv'] = arguments(config,name,parameter,[])
        controls['freeze'] = reservation['lock']
        row.update(status='passed' if passed else 'failed', session=session, reservation=reservation, selected=[item['origin'] for item in fragments],
                   gatherHealth='verified',
                   controls=digest(controls) if session else None, checker=checked, durationMs=result.get('duration_ms'),
                   delivery='empty' if not fragments else 'delivered', trace=trace, adoption=adoption, adoptionToolIds=cited,
                   spend=spend, reportedUSD=str(costs[0]) if terminal and spend in ('over-cap','within-cap') else None,
                   tokens=sum(tokens) if all(type(value) is int and value >= 0 for value in tokens) else None,
                   estimatedUSD=float(costs[0]) if spend == 'within-cap' else None)
    reserved = sum(row['reservation']['capCents'] for row in rows if 'reservation' in row)
    require(reserved <= config['totalCents'], 'reservation total exceeds frozen budget')
    comparisons = []
    for offset in range(0, len(rows), 3):
        triad = {row['slot'].split('-')[-1]: row for row in rows[offset:offset+3]}
        item = {'group':rows[offset]['slot'].rsplit('-',1)[0], 'matched':False, 'deltas':{}}
        comparisons.append(item)
        keys = {row.get('controls') for row in triad.values() if row.get('controls')}
        require(len(keys) <= 1, 'native controls differed across arms')
        if not all(row.get('controls') and row['trace'] == 'verified' and row['spend'] == 'within-cap' for row in triad.values()):
            continue
        item['matched'] = True
        for baseline, treatment in [('none','old'),('old','new'),('none','new')]:
            first, second = triad[baseline], triad[treatment]
            delta = {key: second[key]-first[key] if first[key] is not None and second[key] is not None else None
                     for key in ('estimatedUSD','tokens','durationMs')}
            delta.update(success=int(second['status']=='passed')-int(first['status']=='passed'))
            delta.update({key: second['checker'][key]-first['checker'][key] for key in ('recurrence','stationCommands')})
            item['deltas'][treatment+'-'+baseline] = delta
    return {'rows':rows, 'comparisons':comparisons, 'reservedCents':reserved, 'capCents':config['totalCents']}


if __name__ == '__main__':
    os.umask(0o077)
    command, *args = sys.argv[1:]
    if command == 'template':
        print(json.dumps(template(), ensure_ascii=False, indent=2))
    elif command == 'freeze':
        freeze(Path(args[0]), Path(args[1]).resolve())
    elif command == 'run':
        run(Path(args[0]).resolve(), args[1], int(args[2]), int(args[3]))
    elif command == 'replay':
        print(json.dumps(replay(Path(args[0]).resolve()), ensure_ascii=False, indent=2))
    elif command == 'check-live':
        print(json.dumps(check_live(Path(args[0]).resolve()), ensure_ascii=False, indent=2))
    else:
        sys.exit(__doc__)
