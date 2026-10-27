import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("session_source.py")
SPEC = importlib.util.spec_from_file_location("session_source", SCRIPT)
SOURCE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SOURCE)


class SessionSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def test_claude_jsonl_and_sidechain_filter(self):
        path = self.write("s.jsonl", "\n".join([
            json.dumps({"type":"user","message":{"role":"user","content":[{"type":"text","text":"问题"}]}}),
            json.dumps({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"答案"}]}}),
            json.dumps({"type":"assistant","isSidechain":True,"message":{"role":"assistant","content":"skip"}})]))
        messages, malformed = SOURCE.parse_file(path)
        self.assertEqual(malformed, 0)
        self.assertEqual([m["content"] for m in messages], ["问题", "答案"])

    def test_codex_rollout_records(self):
        path = self.write("r.jsonl", "\n".join([
            json.dumps({"type":"event_msg","payload":{"type":"user_message","message":"问题"}}),
            json.dumps({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"回答"}]}})]))
        messages, _ = SOURCE.parse_file(path)
        self.assertEqual([m["role"] for m in messages], ["user", "assistant"])

    def test_chatgpt_mapping_json_export(self):
        path = self.write("chat.json", json.dumps({"mapping":{
            "a":{"message":{"author":{"role":"user"},"content":{"parts":["问题"]}}},
            "b":{"message":{"author":{"role":"assistant"},"content":{"parts":["回答"]}}}}}))
        messages, _ = SOURCE.parse_file(path)
        self.assertEqual([m["content"] for m in messages], ["问题", "回答"])

    def test_generic_jsonl(self):
        path = self.write("x.jsonl", json.dumps({"role":"user","content":"hello"}))
        messages, malformed = SOURCE.parse_file(path)
        self.assertEqual((messages[0]["content"], malformed), ("hello", 0))

    def test_text_export_is_preserved(self):
        messages, _ = SOURCE.parse_file(self.write("x.md", "User: hi\nAssistant: hello"))
        self.assertEqual(messages[0]["role"], "system")
        self.assertIn("Assistant: hello", messages[0]["content"])

    def test_secrets_redacted(self):
        self.assertEqual(SOURCE.redact("api_key = secret"), "[REDACTED]")
        self.assertIn("[REDACTED PRIVATE KEY]", SOURCE.redact("-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----"))

    def test_malformed_jsonl_is_counted(self):
        messages, malformed = SOURCE.parse_file(self.write("x.jsonl", '{"role":"user","content":"ok"}\n{bad\n'))
        self.assertEqual((len(messages), malformed), (1, 1))

    def test_oversized_transcript_fails_closed(self):
        path = self.write("x.jsonl", json.dumps({"role":"user","content":"x"*30}))
        args = SOURCE.parser().parse_args(["--file", str(path), "--max-chars", "10"])
        with self.assertRaises(SOURCE.SessionError):
            SOURCE.load(args)

    def test_symlink_rejected(self):
        target = self.write("target.md", "text")
        link = self.root / "link.md"
        link.symlink_to(target)
        with self.assertRaises(SOURCE.SessionError):
            SOURCE.parse_file(link)

    def test_discovery_detects_ambiguity(self):
        (self.root / ".claude/projects/p").mkdir(parents=True)
        (self.root / ".codex/sessions").mkdir(parents=True)
        (self.root / ".claude/projects/p/sid-1.jsonl").write_text('{"role":"user","content":"a"}', encoding="utf-8")
        (self.root / ".codex/sessions/rollout-sid-1.jsonl").write_text('{"role":"user","content":"b"}', encoding="utf-8")
        with patch.object(SOURCE.Path, "home", return_value=self.root):
            with self.assertRaises(SOURCE.SessionError):
                SOURCE.discover("sid-1", "auto")

    def test_cli_json_report(self):
        path = self.write("x.json", json.dumps({"messages":[{"role":"user","content":"hi"}]}))
        result = subprocess.run([sys.executable, str(SCRIPT), "--file", str(path)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)["message_count"], 1)


if __name__ == "__main__":
    unittest.main()
