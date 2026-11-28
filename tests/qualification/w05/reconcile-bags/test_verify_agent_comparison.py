from copy import deepcopy
import runpy
import unittest
from pathlib import Path


verifier = runpy.run_path(str(Path(__file__).with_name('verify-agent-comparison.py')))
matches_answer = verifier['matches_answer']
check_project_skill_load = verifier['check_project_skill_load']


class AnswerTests(unittest.TestCase):
    def test_only_json_can_satisfy_the_recorded_answer(self):
        for token in ('refuse-before-read', 'request-missing-page'):
            with self.subTest(token=token):
                self.assertTrue(matches_answer(f'"{token}"', token))
                self.assertFalse(matches_answer(token, token))
                self.assertFalse(matches_answer(f'```json\n"{token}"\n```', token))
        self.assertFalse(matches_answer('{"missing":[],"extra":[]}', {'missing': ['H-502'], 'extra': []}))
        self.assertTrue(matches_answer('{"missing":["H-502"],"extra":[]}', {'missing': ['H-502'], 'extra': []}))


class InstalledSkillTests(unittest.TestCase):
    def test_native_expansion_binds_arguments_edition_and_order(self):
        skill_dir = Path('/isolated/.claude/skills/reconcile-bags')
        asset = '---\nname: reconcile-bags\n---\n\nRead the approved handoff.\n'
        arguments = 'Use handoff.json.'
        command = {
            'type': 'user', 'message': {'content': '<command-message>reconcile-bags</command-message>\n'
            '<command-name>/reconcile-bags</command-name>\n<command-args>Use handoff.json.</command-args>'},
        }
        expansion = {
            'type': 'user', 'message': {'content': [{'type': 'text', 'text':
            'Base directory for this skill: /isolated/.claude/skills/reconcile-bags\n\n'
            'Read the approved handoff.\n\n\nARGUMENTS: Use handoff.json.'}]},
        }
        result = {'type': 'assistant', 'message': {'content': []}}
        turns = [command, expansion, result]
        skills = ['reconcile-bags']
        self.assertEqual(check_project_skill_load(turns, skills, skill_dir, asset, arguments), [result])
        altered = deepcopy(turns)
        altered[1]['message']['content'][0]['text'] += ' Extra text.'
        for trial, listed, edition, args, reason in (
            (turns, [], asset, arguments, 'discovery'),
            ([command, result, expansion], skills, asset, arguments, 'order'),
            (turns, skills, asset, 'Different input.', 'arguments'),
            (turns, skills, asset.replace('approved', 'draft'), arguments, 'expansion'),
            (altered, skills, asset, arguments, 'expansion'),
        ):
            with self.subTest(reason=reason), self.assertRaisesRegex(AssertionError, reason):
                check_project_skill_load(trial, listed, skill_dir, edition, args)
