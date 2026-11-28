import runpy
import unittest
from pathlib import Path


matches_answer = runpy.run_path(str(Path(__file__).with_name('verify-agent-comparison.py')))['matches_answer']


class AnswerTests(unittest.TestCase):
    def test_only_json_can_satisfy_the_recorded_answer(self):
        for token in ('refuse-before-read', 'request-missing-page'):
            with self.subTest(token=token):
                self.assertTrue(matches_answer(f'"{token}"', token))
                self.assertFalse(matches_answer(token, token))
                self.assertFalse(matches_answer(f'```json\n"{token}"\n```', token))
        self.assertFalse(matches_answer('{"missing":[],"extra":[]}', {'missing': ['H-502'], 'extra': []}))
        self.assertTrue(matches_answer('{"missing":["H-502"],"extra":[]}', {'missing': ['H-502'], 'extra': []}))
