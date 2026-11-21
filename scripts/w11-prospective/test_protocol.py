"""Offline protocol regressions. Both subprocess stand-ins are deliberately synthetic."""
import base64
import copy
import json
import sqlite3
import subprocess
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from contextlib import closing
from decimal import Decimal

import protocol
from station import score, transition


PROVIDER = '''import json, sys, sqlite3
from pathlib import Path
if '--version' in sys.argv:
    print('fixture-provider')
else:
    plans = list((Path.home()/'.afk/learning/publications').glob('*/plan.json'))
    assert (Path.home()/'.afk/plugins.yml').is_file()
    with sqlite3.connect('file:'+str(Path.home()/'.afk/learning/candidates.sqlite')+'?mode=ro', uri=True) as db:
        assert db.execute('select count(*) from learning_ledger where kind="publication"').fetchone()[0] == len(plans)
    print(json.dumps([{'origin':'knowledge:'+plan.parent.name+'; target:'+json.loads(plan.read_text())['targetRef'],
                       'content':json.loads(plan.read_text())['plan']['changes'][0]['content']} for plan in plans]))
'''
AGENT = '''import os, json, sys, uuid, subprocess
if '--version' in sys.argv:
    print('fixture-agent')
    sys.exit()
session = str(uuid.uuid4())
parcel, name = os.environ['W11_PARCEL'], os.environ['W11_SCENARIO']
print(json.dumps(dict(type='system',subtype='init',model='claude-sonnet-4-6',session_id=session,
                      tools=['Bash'],permissionMode='dontAsk',plugins=[],skills=[],mcp_servers=[],claude_code_version='fixture')))
commands = {'environment':[['lookup','staging',parcel]], 'process':[['核对袋号',parcel],['登记签收',parcel]],
            'repair':[['pitch',parcel,'104' if parcel=='W11-101' else '84'],['print',parcel],['print',parcel]]}
outputs = []
for index, command in enumerate(commands[name], 1):
    ident = 'tool-'+str(index)
    block = dict(type='tool_use',id=ident,name='Bash',input=dict(command=' '.join(['python3','station.py',*command])))
    print(json.dumps(dict(type='assistant',session_id=session,message=dict(content=[block]))))
    call = subprocess.run(['python3','station.py',*command],text=True,capture_output=True)
    output = call.stdout
    outputs.append(json.loads(output))
    block = dict(type='tool_result',tool_use_id=ident,is_error=bool(call.returncode),content=[dict(type='text',text=output)])
    print(json.dumps(dict(type='user',session_id=session,message=dict(content=[block]))))
prompt = sys.argv[sys.argv.index('--system-prompt')+1].splitlines()
claim = None if len(prompt)==1 else dict(origin=prompt[-2],quote=prompt[-1],steps=list(range(1,len(outputs)+1)))
answer = json.dumps(dict(answer=outputs[-2:] if name=='repair' else outputs[-1],adoption=claim))
print(json.dumps(dict(type='result',subtype='success',session_id=session,result=answer,duration_ms=1,
                      usage=dict(input_tokens=1,output_tokens=1,cache_creation_input_tokens=0,cache_read_input_tokens=0),total_cost_usd=.01)))
'''


class QueueTest(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.base = Path(scratch.name).resolve()
        self.spec = self.base/'spec.json'
        self.root = self.base/'run'
        package = self.base/'installed'
        (package/'dist').mkdir(parents=True)
        (package/'node_modules').mkdir()
        for file in ('release.json','package.json'):
            protocol.save(package/file, {'version':'fixture'})
        cli, agent = package/'dist/index.js', self.base/'agent'
        cli.write_text(PROVIDER)
        agent.write_text('#!'+sys.executable+'\n'+AGENT)
        agent.chmod(0o700)
        self.config = protocol.template()
        self.config.update(cli=str(cli), agent=str(agent), node=sys.executable)

    def edition(self, name, arm, predecessor=None):
        folder = self.base/(name+arm)
        store = folder/'.afk/learning'
        store.mkdir(parents=True)
        (folder/'.afk/plugins.yml').write_text('test provider')
        page = arm+'.md'
        target = 'wiki:'+name
        grant = dict(revoked=False, policy=dict(scope=protocol.SCOPE,targets=[dict(ref=target,paths=[page],kinds=[protocol.KINDS[name]])]))
        protocol.save(folder/'grant.json',grant)
        content = name+arm
        pack = protocol.read(protocol.HERE/'fixtures/product-audit-pack.json')
        entry = pack['entries'][0]
        if predecessor:
            event = json.loads(entry['content'])
            event['data']['note'] = 'W11 supersedes '+predecessor
            entry['content'] = json.dumps(event, sort_keys=True, separators=(',', ':'))
            checksum = protocol.digest(dict(content=entry['content'], position=entry['position'], completeness='complete'))
            entry['ref'].update(id='evidence:'+checksum, digest=checksum)
            pack['digest'] = protocol.digest({key:value for key,value in pack.items() if key != 'digest'})
        common = dict(candidateId=content, candidateDigest=protocol.digest(content),evidenceDigest=pack['digest'],candidateVersion=2,
                      validatorVersion='learning-validation-v1:'+content,targetRef=target)
        change = dict(path=page,content=content,expected_sha256=None)
        plan = dict(**common,plan={'changes':[change]},classification=protocol.KINDS[name],proposal={'targetRef':target},
                    policyDigest=protocol.digest(grant['policy']),authorizationDigest=protocol.digest(grant),authorizationFile=str(folder/'grant.json'))
        key = protocol.digest(plan)
        plans = store/'publications'/key
        plans.mkdir(parents=True)
        protocol.save(plans/'plan.json',plan)
        after = protocol.digest([dict(path=page,sha256=protocol.sha(content.encode()))])
        pub = dict(**common,key=key,phase='committed',targetDigest=after,observedDigest=after,originalDigest=protocol.digest([dict(path=page,sha256=None)]))
        binding = {**common,'candidateVersion':1,'executionId':content,'scope':protocol.SCOPE,'target':dict(ref=target,scope=protocol.SCOPE)}
        reference = {key:entry['ref'][key] for key in ('id','digest','locator')}
        check = dict(protocol='learning-validation-v1',binding=binding,assertions=[dict(status='observed',expected='ok',actual='ok',evidence=[reference])])
        receipt = protocol.digest(check)
        validation = dict(status='validated',candidateId=content,candidateVersion=1,validatedVersion=2,executionId=content,receiptDigest=receipt)
        for file, data in [('validation',validation),('independent-check',check),('publication',pub)]:
            protocol.save(folder/(file+'.json'),data)
        encoded = base64.b64encode(json.dumps(dict(report=check,receiptDigest=receipt)).encode()).decode()
        with closing(sqlite3.connect(store/'candidates.sqlite')) as db, db:
            db.execute('create table learning_ledger(kind text, key text, payload text, primary key(kind,key))')
            for kind, data in [('publication',pub),('validation',{**common,'passed':True,'candidateVersion':1,'validatedVersion':2,'results':['json-base64-v1:'+encoded]}),
                               ('snapshot',pack)]:
                db.execute('insert into learning_ledger values (?,?,?)',(kind,pack['digest'] if kind=='snapshot' else key,json.dumps(data)))
        commands = {'process': [['核对袋号','{parcel}'], ['登记签收','{parcel}']], 'environment': [['lookup','staging','{parcel}']]}
        edition = dict(profile=str(folder),evidence=str(folder),page=page)
        if name in commands:
            edition['adoption'] = dict(quote=content,commands=commands[name])
        return key, edition

    def group(self, name, linked=True):
        old_key, old = self.edition(name,'old')
        _, new = self.edition(name,'new',old_key if linked else None)
        self.config['groups'][name] = dict(old=old,new=new,targetRef='wiki:'+name,query=dict(scope=protocol.SCOPE,prompt=protocol.PROMPTS[name],limit=5,
                                            applicability=dict(environment='staging'),target=dict(project=protocol.SCOPE)))

    def freeze(self):
        protocol.save(self.spec,self.config)
        protocol.freeze(self.spec,self.root)

    def test_full_queue_and_replay(self):
        for name in protocol.PROMPTS:
            self.group(name)
        self.freeze()
        with self.assertRaisesRegex(ValueError,'budget'):
            protocol.run(self.root,'repair',1,224)
        for name in protocol.PROMPTS:
            for repeat in (1,2):
                protocol.run(self.root,name,repeat,225)
        report = protocol.replay(self.root)
        self.assertEqual(len(report['rows']),18)
        self.assertEqual({row['status'] for row in report['rows']},{'passed'})
        self.assertEqual(len({row['session'] for row in report['rows']}),18)
        self.assertEqual(report['reservedCents'], 1350)
        self.assertEqual([row['adoption'] for row in report['rows'][:3]], ['inapplicable', 'observed', 'observed'])
        self.assertEqual(report['rows'][7]['adoption'], 'unregistered')
        for item in report['comparisons']:
            self.assertTrue(item['matched'])
            self.assertEqual(set(item['deltas']),{'new-old','new-none','old-none'})
        with self.assertRaisesRegex(ValueError,'open slots'):
            protocol.run(self.root,'repair',1,225)
        (self.root/'attempts/process-2-old/journal.jsonl').write_text('')
        with self.assertRaisesRegex(ValueError,'artifacts changed'):
            protocol.replay(self.root)

    def test_parallel_publications_rejected(self):
        self.group('process',linked=False)
        with self.assertRaisesRegex(ValueError,'successive'):
            self.freeze()

    def test_injected_marker_in_unrelated_product_snapshot(self):
        self.group('process', linked=False)
        old_key = protocol.read(self.base/'processold/publication.json')['key']
        with closing(sqlite3.connect(self.base/'processnew/.afk/learning/candidates.sqlite')) as db, db:
            pack = json.loads(db.execute("select payload from learning_ledger where kind='snapshot'").fetchone()[0])
            entry = pack['entries'][0]
            self.assertEqual(protocol.evidence_predecessors(pack, pack['digest'], [{'evidence':[entry['ref']]}]), {'a'*64})
            entry['content'] = entry['content'].replace('a'*64, old_key)
            db.execute("update learning_ledger set payload=? where kind='snapshot'", (json.dumps(pack),))
        with self.assertRaisesRegex(ValueError, 'evidence pack digest'):
            self.freeze()
        pack['digest'] = protocol.digest({key:value for key,value in pack.items() if key != 'digest'})
        with self.assertRaisesRegex(ValueError, 'evidence entry digest'):
            protocol.evidence_predecessors(pack, pack['digest'], [])

    def test_product_snapshot_lookup_and_qa_reference(self):
        self.group('process')
        old_key = protocol.read(self.base/'processold/publication.json')['key']
        with closing(sqlite3.connect(self.base/'processnew/.afk/learning/candidates.sqlite')) as db, db:
            pack = json.loads(db.execute("select payload from learning_ledger where kind='snapshot'").fetchone()[0])
            db.execute("update learning_ledger set key='other' where kind='snapshot'")
        with self.assertRaisesRegex(ValueError, 'missing or ambiguous product snapshot'):
            self.freeze()
        ref = pack['entries'][0]['ref']
        for field in ('id','digest','locator'):
            with self.subTest(field=field):
                wrong = {**ref, field:'other'}
                self.assertEqual(protocol.evidence_predecessors(pack, pack['digest'], [{'evidence':[wrong]}]), set())
        self.assertEqual(protocol.evidence_predecessors(pack, pack['digest'], [{'evidence':[ref]}]), {old_key})

    def test_tampered_checker_rejected(self):
        self.group('repair')
        file = self.base/'repairold/independent-check.json'
        report = protocol.read(file)
        report['assertions'][0].update(expected='substitute',actual='substitute')
        file.write_text(json.dumps(report))
        with self.assertRaisesRegex(ValueError,'receipt digest'):
            self.freeze()

    def test_revocation_and_unknown_spend(self):
        self.group('process')
        self.freeze()
        file = self.base/'processold/grant.json'
        file.write_text(json.dumps({**protocol.read(file),'revoked':True}))
        with self.assertRaisesRegex(ValueError,'live grant revoked'):
            protocol.run(self.root,'process',1,225)
        row = protocol.replay(self.root)['rows'][12]
        self.assertEqual((row['status'], row['spend']), ('prelaunch-blocked','not-launched'))
        self.assertEqual(protocol.check_live(self.root)['groups']['process'], dict(none='live grant revoked',old='live grant revoked',new='healthy'))

    def test_closed_source_home_recall_and_budget(self):
        self.group('process')
        self.config['groups']['process']['old']['sourceHome'] = True
        self.config.update(totalCents=225)
        self.freeze()
        protocol.run(self.root,'process',1,225)
        with self.assertRaisesRegex(ValueError,'budget'):
            protocol.run(self.root,'process',2,225)

    def test_ambiguous_recall_is_rejected_before_agent(self):
        self.group('process')
        provider = Path(self.config['cli'])
        provider.write_text(PROVIDER.replace('for plan in plans]', 'for plan in plans*2]'))
        with self.assertRaisesRegex(ValueError,'uniquely recalled'):
            self.freeze()
        self.assertFalse((self.root/'attempts').exists())

    def test_wrong_treatment_is_rejected(self):
        self.group('process')
        provider = Path(self.config['cli'])
        provider.write_text(PROVIDER.replace("['changes'][0]['content']", "['changes'][0]['content']+'other'"))
        with self.assertRaisesRegex(ValueError,'differs from recall'):
            self.freeze()

    def test_missing_groups_and_freeze_drift(self):
        self.freeze()
        rows = protocol.replay(self.root)['rows']
        self.assertEqual([row['status'] for row in rows],['missing-publications']*18)
        with self.assertRaisesRegex(ValueError,'lacks admitted'):
            protocol.run(self.root,'environment',1,225)
        (self.root/'frozen/schedule.json').write_text('[]')
        with self.assertRaisesRegex(ValueError,'frozen inputs changed'):
            protocol.replay(self.root)

    def test_negative_spend_stops_first_launch_and_replay(self):
        self.group('process')
        agent = Path(self.config['agent'])
        agent.write_text(agent.read_text().replace('total_cost_usd=.01', 'total_cost_usd=-1'))
        self.freeze()
        with self.assertRaisesRegex(ValueError, 'unresolved spend: invalid'):
            protocol.run(self.root,'process',1,225)
        report = protocol.replay(self.root)
        self.assertEqual(report['reservedCents'], 75)
        self.assertEqual([row['status'] for row in report['rows'][12:15]], ['failed','pending','pending'])
        self.assertFalse(report['comparisons'][4]['matched'])
        with self.assertRaisesRegex(ValueError, 'prior attempt has unresolved spend'):
            protocol.run(self.root,'process',2,225)

    def test_native_cost_limits(self):
        for cost, expected in [(None,'unknown'), (True,'invalid'), ('0','invalid'), (float('nan'),'invalid'),
                               (Decimal('Infinity'),'invalid'), (-1,'invalid'), (0,'within-cap'), (Decimal('.7500'),'within-cap'),
                               (Decimal('.750000000000000000000001'),'over-cap')]:
            with self.subTest(cost=cost):
                self.assertEqual(protocol.spend_status(cost,75), expected)

    def test_foreign_assistant_stops_reservations_and_relocates(self):
        self.group('process')
        agent = Path(self.config['agent'])
        mixed = "print(json.dumps(dict(type='assistant',session_id='foreign',message=dict(content=[dict(type='text',text='fixture')]))))"
        agent.write_text(agent.read_text().replace('outputs = []', mixed+'\noutputs = []'))
        self.freeze()
        with self.assertRaisesRegex(ValueError, 'unresolved spend: unknown'):
            protocol.run(self.root,'process',1,225)
        report = protocol.replay(self.root)
        first, old, new = report['rows'][12:15]
        self.assertEqual((first['spend'],first['trace'],first['reportedUSD'],first['estimatedUSD']), ('unknown','invalid',None,None))
        self.assertEqual((old['status'], new['status'], report['reservedCents']), ('pending','pending',75))
        self.assertEqual([seat.name for seat in (self.root/'attempts').iterdir()], ['process-1-none'])
        with self.assertRaisesRegex(ValueError, 'prior attempt has unresolved spend'):
            protocol.run(self.root,'process',2,225)
        self.assertEqual(self.relocated_replay(), report)

    def test_cited_failed_step_in_successful_task(self):
        self.group('process')
        agent = Path(self.config['agent'])
        source = agent.read_text().replace("[['核对袋号',parcel],['登记签收',parcel]]", "[['核对袋号',parcel],['核对袋号',parcel],['登记签收',parcel]]")
        agent.write_text(source.replace('steps=list(range(1,len(outputs)+1))', "steps=[2 if prompt[-1]=='processold' else 1,3]"))
        self.freeze()
        protocol.run(self.root,'process',1,225)
        old, new = protocol.replay(self.root)['rows'][13:15]
        for row in (old,new):
            self.assertEqual((row['status'],row['trace'],row['checker']['passed']), ('passed','verified',True))
        self.assertEqual((old['adoption'], old['adoptionToolIds']), ('unobserved', []))
        self.assertEqual((new['adoption'], new['adoptionToolIds']), ('observed', ['tool-1','tool-3']))

    def test_invalid_receipts_and_unobserved_adoption(self):
        self.group('process')
        self.freeze()
        protocol.run(self.root,'process',1,225)
        seat = self.root/'attempts/process-1-old'
        output = seat/'stdout.jsonl'
        original = [json.loads(line) for line in output.read_text().splitlines()]
        def block(events, index):
            return events[index]['message']['content'][0]
        def change_final(events, **values):
            events[-1]['result'] = json.dumps({**json.loads(events[-1]['result']), **values})
        def replay_with(events):
            output.write_text(''.join(json.dumps(event)+'\n' for event in events))
            hashes = protocol.read(seat/'files.json')
            hashes['stdout.jsonl'] = protocol.sha(output.read_bytes())
            (seat/'files.json').write_text(json.dumps(hashes))
            report = protocol.replay(self.root)
            return report['rows'][13], report['comparisons'][4]['matched']
        for mutation in (lambda ev: ev.pop(2), lambda ev: ev.insert(3,ev[2]), lambda ev: ev.reverse(),
                         lambda ev: block(ev,1).update(name='Read'), lambda ev: block(ev,1)['input'].update(command='python3 station.py help; pwd'),
                         lambda ev: block(ev,1)['input'].update(run_in_background=True), lambda ev: ev[1].update(session_id='other'),
                         lambda ev: block(ev,2).update(tool_use_id='other'), lambda ev: block(ev,2).update(content='{}'),
                         lambda ev: block(ev,2).update(is_error=True), lambda ev: block(ev,3).update(id=block(ev,1)['id'])):
            events = copy.deepcopy(original)
            mutation(events)
            row, matched = replay_with(events)
            self.assertEqual((row['status'],row['trace'],row['adoption'],matched), ('failed','invalid','unassessable',False))
        claim = json.loads(original[-1]['result'])['adoption']
        for altered in (None,{**claim,'origin':'other'},{**claim,'steps':[2,1]},{**claim,'steps':[True,2]},{**claim,'quote':'other'}):
            events = copy.deepcopy(original)
            change_final(events,adoption=altered)
            row, matched = replay_with(events)
            self.assertEqual((row['status'],row['delivery'],row['adoption'],matched), ('passed','delivered','unobserved',True))
        for answer in ('W11-101 未完成，不能说已签收', {'parcel':'W11-101','state':'未签收'}, {'parcel':'W11-101','state':'已签收','extra':True}):
            events = copy.deepcopy(original)
            change_final(events,answer=answer)
            row, matched = replay_with(events)
            self.assertEqual((row['status'],row['adoption'],matched), ('failed','observed',True))
        for cost in (None,False,'free',float('nan'),float('inf'),-1,.751):
            events = copy.deepcopy(original)
            events[-1]['total_cost_usd'] = cost
            row, matched = replay_with(events)
            self.assertEqual((row['status'],row['estimatedUSD'],matched), ('failed',None,False))

    def relocated_replay(self):
        moved = self.base/'relocated archive'
        self.root.rename(moved)
        return self.archived_replay(moved)

    def archived_replay(self, moved):
        return json.loads(subprocess.check_output([sys.executable,'-E','-B',str(moved/'frozen/protocol.py'),'replay',str(moved)],
                                                  cwd=self.base))

    def test_archive_relocation_authority_and_dependency_drift(self):
        self.group('process')
        self.config['groups']['process']['old']['sourceHome'] = True
        self.freeze()
        protocol.run(self.root,'process',1,225)
        before = protocol.replay(self.root)
        moved = self.base/'moved queue'
        self.root.rename(moved)
        self.assertEqual(self.archived_replay(moved), before)
        self.assertEqual(set(protocol.check_live(moved)['groups']['process'].values()), {'healthy'})
        (self.base/'processold/.afk').rename(self.base/'removed-home')
        self.assertEqual(protocol.check_live(moved)['groups']['process']['old'], 'source profile unavailable')
        (self.base/'processold/grant.json').unlink()
        self.assertEqual(protocol.check_live(moved)['groups']['process']['old'], 'live grant unavailable')
        (self.base/'installed/node_modules/dependency.js').write_text('drift')
        self.assertEqual(protocol.check_live(moved)['tools'], 'installed package drift')
        with self.assertRaisesRegex(ValueError, 'installed package drift'):
            protocol.run(moved,'process',2,225)
        shutil.rmtree(self.base/'installed')
        Path(self.config['agent']).unlink()
        self.assertEqual(protocol.check_live(moved)['groups']['process']['new'], 'unavailable')
        self.assertEqual(self.archived_replay(moved), before)

    def test_silent_provider_failure_is_not_healthy_empty(self):
        self.group('process')
        provider = Path(self.config['cli'])
        provider.write_text(PROVIDER[:PROVIDER.index('    plans =')] + "    print('[]')\n")
        with self.assertRaisesRegex(ValueError, 'uniquely recalled'):
            self.freeze()
        self.assertFalse((self.root/'preflight-process-none/health.json').exists())

    def test_station_independent_negatives(self):
        parcel = 'W11-101'
        def check(name, commands, answer=parcel):
            outputs = transition(name,parcel,commands)
            return score(name,parcel,[dict(command=cmd,result=out) for cmd,out in zip(commands,outputs)],answer)
        self.assertFalse(check('environment',[],json.dumps(dict(parcel=parcel,environment='staging',record='s-78bf')))['passed'])
        self.assertTrue(check('process',[['登记签收',parcel],['核对袋号',parcel],['登记签收',parcel]],parcel+' 已签收')['recurrence'])
        self.assertFalse(check('process',[['登记签收',parcel]],parcel+' 已签收')['passed'])
        self.assertFalse(check('repair',[['pitch',parcel,'103.99'],['print',parcel],['print',parcel]])['passed'])
        self.assertFalse(check('repair',[['pitch',parcel,'104'],['print',parcel],['media',parcel],['print',parcel]])['passed'])
        commands = [['pitch',parcel,'104'],['print',parcel],['print',parcel]]
        prints = transition('repair',parcel,commands)[-2:]
        self.assertTrue(check('repair',commands,prints)['passed'])
        self.assertFalse(check('repair',commands,[prints[1],prints[0]])['passed'])
        self.assertFalse(check('repair',commands,[{**prints[0],'offset':False},prints[1]])['passed'])
        with self.assertRaisesRegex(ValueError,'journal'):
            score('process',parcel,[dict(command=['登记签收',parcel],result={'state':'已签收'})],parcel+' 已签收')
