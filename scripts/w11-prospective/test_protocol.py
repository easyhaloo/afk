"""Offline protocol regressions. Both subprocess stand-ins are deliberately synthetic."""
import base64
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from contextlib import closing

import protocol
from station import score, transition


PROVIDER = '''import json, sys
from pathlib import Path
if '--version' in sys.argv:
    print('fixture-provider')
else:
    plans = list((Path.home()/'.afk/learning/publications').glob('*/plan.json'))
    assert (Path.home()/'.afk/plugins.yml').is_file()
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
for command in commands[name]:
    output = subprocess.check_output(['python3','station.py',*command],text=True)
answer = output if name=='environment' else parcel+' 已签收'
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
        cli, agent = self.base/'provider.py', self.base/'agent'
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
        marker = 'W11 supersedes '+predecessor if predecessor else 'initial evidence'
        entry = dict(content=marker,ref=dict(id='e1',authority='observed',completeness='complete'))
        common = dict(candidateId=content, candidateDigest=protocol.digest(content),evidenceDigest=protocol.digest(entry),candidateVersion=2,
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
        check = dict(protocol='learning-validation-v1',binding=binding,assertions=[dict(status='observed',expected='ok',actual='ok',evidence=[dict(id='e1')])])
        receipt = protocol.digest(check)
        validation = dict(status='validated',candidateId=content,candidateVersion=1,validatedVersion=2,executionId=content,receiptDigest=receipt)
        for file, data in [('validation',validation),('independent-check',check),('publication',pub)]:
            protocol.save(folder/(file+'.json'),data)
        encoded = base64.b64encode(json.dumps(dict(report=check,receiptDigest=receipt)).encode()).decode()
        with closing(sqlite3.connect(store/'candidates.sqlite')) as db, db:
            db.execute('create table learning_ledger(kind text, payload text)')
            for kind, data in [('publication',pub),('validation',{**common,'passed':True,'candidateVersion':1,'validatedVersion':2,'results':['json-base64-v1:'+encoded]}),
                               ('snapshot',dict(entries=[entry],digest=common['evidenceDigest'],completeness='complete'))]:
                db.execute('insert into learning_ledger values (?,?)',(kind,json.dumps(data)))
        return key, dict(profile=str(folder),evidence=str(folder),page=page)

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
        with self.assertRaisesRegex(ValueError,'live grant changed'):
            protocol.run(self.root,'process',1,225)
        with self.assertRaisesRegex(ValueError,'unresolved spend'):
            protocol.run(self.root,'process',1,225)
        self.assertEqual(protocol.replay(self.root)['rows'][12]['status'],'interrupted')

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
        with self.assertRaisesRegex(ValueError,'journal'):
            score('process',parcel,[dict(command=['登记签收',parcel],result={'state':'已签收'})],parcel+' 已签收')
