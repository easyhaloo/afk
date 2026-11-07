import contextlib
import datetime
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


CLI = Path(__file__).with_name("wiki.py")
TODAY = datetime.date.today().isoformat()


def page(title, body, aliases=""):
    return (
        f"---\ntags: [wiki]\nlast_updated: {TODAY}\n{aliases}---\n"
        f"# {title}\n\n## 内容\n\n{body}\n"
    )


class WikiE2E(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="wiki-e2e-")
        self.addCleanup(self.temporary.cleanup)
        self.workspace = Path(self.temporary.name).resolve()
        self.vault = self.workspace / "vault"
        self.vault.mkdir()
        self.write("AGENTS.md", "# Rules\nUse templates; facts need evidence.\n")
        self.write("00-总览.md", page("总览", "[[知识/入口]]"))
        self.write("知识/_模板.md", page("模板", "正文。"))
        self.write("知识/入口.md", page("入口", "现有事实。[[00-总览]]", "aliases: [入口别名]\n"))
        self.plan_file = self.workspace / "plan.json"
        self.config_home = self.workspace / "config"

    def write(self, relative, content):
        target = self.vault / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return target

    def snapshot(self):
        return {
            str(target.relative_to(self.vault)): target.read_bytes()
            for target in self.vault.rglob("*") if target.is_file()
        }

    def invoke(self, *arguments, expected=0, environment=None, stdin=None):
        result = subprocess.run(
            [sys.executable, "-B", str(CLI), *arguments, "--json"],
            input=stdin, capture_output=True, text=True, cwd=self.workspace,
            env={**os.environ, "WIKI_VAULT": str(self.vault), "XDG_CONFIG_HOME": str(self.config_home), **(environment or {})},
            timeout=30,
        )
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        self.assertEqual(result.stderr, "", result.stderr)
        return json.loads(result.stdout)

    def change(self, relative, content):
        target = self.vault / relative
        return {
            "path": relative,
            "expected_sha256": hashlib.sha256(target.read_bytes()).hexdigest() if target.is_file() else None,
            "content": content,
        }

    def plan(self, changes):
        document = {
            "version": 1,
            "summary": "沉淀已验证的知识",
            "evidence": ["当前上下文中的测试结果：已验证。"],
            "changes": changes,
        }
        self.plan_file.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
        return document

    def new_knowledge(self):
        return self.plan([
            self.change("知识/新知识.md", page("新知识", "经过验证的新事实。[[入口]]")),
            self.change("知识/入口.md", page("入口", "现有事实。[[00-总览]] [[新知识]]", "aliases: [入口别名]\n")),
            self.change("00-总览.md", page("总览", "[[知识/入口]] [[知识/新知识]]")),
        ])

    def test_complete_preview_apply_search_read_lint_and_replay(self):
        self.assertTrue(CLI.is_file(), "Bundled wiki CLI must exist")
        initial = self.snapshot()
        document = self.new_knowledge()
        preview = self.invoke("ingest", "--plan", str(self.plan_file))
        self.assertEqual(preview["status"], "preview")
        self.assertEqual(len(preview["changes"]), 3)
        self.assertIn("经过验证的新事实", preview["changes"][0]["diff"])
        self.assertEqual(self.snapshot(), initial)
        entry = self.vault / "知识/入口.md"
        entry.chmod(0o640)
        applied = self.invoke("ingest", "--plan", str(self.plan_file), "--apply")
        self.assertEqual(applied["status"], "applied")
        self.assertEqual(entry.stat().st_mode & 0o777, 0o640)
        self.assertEqual(len(applied["applied"]), 3)
        for change in document["changes"]:
            self.assertEqual((self.vault / change["path"]).read_text(), change["content"])
        results = self.invoke("search", "新事实")["results"]
        self.assertEqual(results[0]["path"], "知识/新知识.md")
        self.assertGreater(results[0]["line"], 1)
        read = self.invoke("read", "知识/新知识.md", "--heading", "内容")
        self.assertIn("经过验证的新事实", read["content"])
        self.assertEqual(read["sha256"], hashlib.sha256((self.vault / read["path"]).read_bytes()).hexdigest())
        self.assertEqual(self.invoke("lint")["summary"]["error"], 0)
        before_replay = {target: (self.vault / target).stat().st_mtime_ns for target in self.snapshot()}
        self.assertEqual(self.invoke("ingest", "--plan", str(self.plan_file), "--apply")["status"], "unchanged")
        self.assertEqual(before_replay, {target: (self.vault / target).stat().st_mtime_ns for target in self.snapshot()})

    def test_search_alias_regex_literal_empty_and_sensitive_exclusion(self):
        self.write("30-账户凭证/凭证.md", page("凭证", "needle-secret"))
        self.write(".obsidian/private.md", "needle-secret")
        outside = self.workspace / "outside.md"
        outside.write_text("needle-secret")
        (self.vault / "outside.md").symlink_to(outside)
        self.assertEqual(self.invoke("search", "needle-secret")["results"], [])
        self.assertEqual(self.invoke("search", "入口别名")["results"][0]["matched_by"], "alias")
        self.assertEqual(self.invoke("search", ".*")["results"], [])
        self.assertTrue(self.invoke("search", "现有.*事实", "--regex")["results"])
        self.assertEqual(self.invoke("search", "不存在")["results"], [])
        self.invoke("search", "[", "--regex", expected=2)

    def test_missing_vault_invalid_options_and_global_option_positions(self):
        self.invoke("search", "入口", environment={"WIKI_VAULT": str(self.workspace / "missing")}, expected=2)
        self.invoke("search", "", expected=2)
        self.invoke("search", "入口", "--limit", "0", expected=2)
        self.invoke("search", "入口", "--unknown", expected=2)
        self.invoke("--vault", str(self.vault), "search", "入口")
        self.invoke("search", "入口", "--vault", str(self.vault))

    def test_default_vault_config_resolves_without_path_or_environment(self):
        configured = self.config_home / "wiki/config.json"
        configured.parent.mkdir(parents=True)
        configured.write_text(json.dumps({"vault": str(self.vault)}))
        location = self.invoke("locate", environment={"WIKI_VAULT": ""})
        self.assertEqual(location["vault"], str(self.vault))
        self.assertEqual(location["vault_source"], str(configured))
        results = self.invoke("search", "入口别名", environment={"WIKI_VAULT": ""})
        self.assertEqual(results["results"][0]["path"], "知识/入口.md")
        self.assertEqual(results["vault"], str(self.vault))

    def test_project_binding_overrides_default_and_resolves_relative_paths(self):
        configured = self.config_home / "wiki/config.json"
        configured.parent.mkdir(parents=True)
        configured.write_text(json.dumps({"vault": str(self.workspace / "missing")}))
        project = self.workspace / ".wiki.json"
        project.write_text(json.dumps({"vault": "vault"}))
        location = self.invoke("locate", environment={"WIKI_VAULT": ""})
        self.assertEqual(location["vault"], str(self.vault))
        self.assertEqual(location["vault_source"], str(project))
        nested = self.workspace / "nested/project"
        nested.mkdir(parents=True)
        result = subprocess.run(
            [sys.executable, "-B", str(CLI), "locate", "--json"],
            capture_output=True, text=True, cwd=nested,
            env={**os.environ, "WIKI_VAULT": "", "XDG_CONFIG_HOME": str(self.config_home)}, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)["vault_source"], str(project))

    def test_explicit_path_and_environment_override_project_binding(self):
        (self.workspace / ".wiki.json").write_text(json.dumps({"vault": "missing"}))
        location = self.invoke("locate")
        self.assertEqual(location["vault_source"], "WIKI_VAULT")
        location = self.invoke("locate", "--vault", str(self.vault), environment={"WIKI_VAULT": str(self.workspace / "missing")})
        self.assertEqual(location["vault_source"], "--vault")

    def test_bad_project_config_fails_instead_of_using_default(self):
        configured = self.config_home / "wiki/config.json"
        configured.parent.mkdir(parents=True)
        configured.write_text(json.dumps({"vault": str(self.vault)}))
        for raw in ("{", "[]", '{"vault": null}', '{"vault": ""}', '{"vault": 12}', '{"vault": "missing"}'):
            with self.subTest(raw=raw):
                (self.workspace / ".wiki.json").write_text(raw)
                self.invoke("locate", environment={"WIKI_VAULT": ""}, expected=2)

    def test_unconfigured_vault_returns_setup_instruction(self):
        failure = self.invoke("locate", environment={"WIKI_VAULT": ""}, expected=2)
        self.assertIn("config.json", failure["error"])

    def test_all_operations_use_project_binding(self):
        (self.workspace / ".wiki.json").write_text(json.dumps({"vault": "vault"}))
        environment = {"WIKI_VAULT": ""}
        self.new_knowledge()
        self.assertEqual(self.invoke("ingest", "--plan", str(self.plan_file), environment=environment)["status"], "preview")
        self.assertEqual(self.invoke("ingest", "--plan", str(self.plan_file), "--apply", environment=environment)["status"], "applied")
        self.assertEqual(self.invoke("read", "知识/新知识.md", environment=environment)["vault"], str(self.vault))
        self.assertEqual(self.invoke("lint", environment=environment)["summary"]["error"], 0)

    def test_read_redacts_credentials_and_rejects_sensitive_or_escaping_paths(self):
        self.write("知识/泄漏.md", page("泄漏", "password = hidden-value\n[[入口]]"))
        read = self.invoke("read", "知识/泄漏.md")
        self.assertTrue(read["redacted"])
        self.assertNotIn("hidden-value", json.dumps(read))
        self.assertNotIn("hidden-value", json.dumps(self.invoke("search", "password")))
        self.assertNotIn("hidden-value", json.dumps(self.invoke("search", "password = hidden-value")))
        self.write("30-账户凭证/凭证.md", "hidden-value")
        for relative in ("../outside.md", str(self.vault / "知识/入口.md"), "30-账户凭证/凭证.md", ".obsidian/private.md"):
            with self.subTest(relative=relative):
                self.invoke("read", relative, expected=2)
        self.invoke("read", "知识/入口.md", "--heading", "不存在", expected=2)

    def test_concurrent_edit_rejects_whole_plan(self):
        self.new_knowledge()
        self.write("知识/入口.md", page("入口", "人工编辑。[[00-总览]]"))
        before = self.snapshot()
        self.invoke("ingest", "--plan", str(self.plan_file), "--apply", expected=3)
        self.assertEqual(self.snapshot(), before)

    def test_bundle_runs_after_relocation(self):
        installed = self.workspace / "installed" / "wiki"
        shutil.copytree(CLI.parent.parent, installed)
        result = subprocess.run(
            [sys.executable, "-B", str(installed / "scripts/wiki.py"), "search", "入口别名", "--vault", str(self.vault), "--json"],
            capture_output=True, text=True, cwd=self.workspace, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)["results"][0]["path"], "知识/入口.md")

    def test_sensitive_tags_are_excluded_from_read_search_and_ingest(self):
        content = page("敏感页", "unique-private-value [[入口]]").replace("[wiki]", "[wiki, 敏感]")
        self.write("知识/敏感页.md", content)
        self.assertEqual(self.invoke("search", "unique-private-value")["results"], [])
        self.invoke("read", "知识/敏感页.md", expected=2)
        self.plan([self.change("知识/敏感页.md", page("敏感页", "[[入口]]"))])
        self.invoke("ingest", "--plan", str(self.plan_file), "--apply", expected=2)

    def test_new_lint_errors_block_apply_and_existing_errors_do_not(self):
        self.write("知识/旧错误.md", page("旧错误", "[[原有断链]]"))
        self.new_knowledge()
        self.assertEqual(self.invoke("ingest", "--plan", str(self.plan_file), "--apply")["status"], "applied")
        self.plan([self.change("知识/新知识.md", page("新知识", "[[新增断链]]"))])
        before = self.snapshot()
        failure = self.invoke("ingest", "--plan", str(self.plan_file), "--apply", expected=1)
        self.assertTrue(failure["new_errors"])
        self.assertEqual(self.snapshot(), before)

    def test_plan_requires_evidence_and_valid_hashes_and_paths(self):
        document = self.new_knowledge()
        document["evidence"] = []
        self.plan_file.write_text(json.dumps(document))
        self.invoke("ingest", "--plan", str(self.plan_file), expected=2)
        for relative in ("../outside.md", ".obsidian/config.md", "AGENTS.md", "知识/_模板.md", "30-账户凭证/新页.md", "知识/data.txt"):
            with self.subTest(relative=relative):
                self.plan([{"path": relative, "expected_sha256": None, "content": "anything"}])
                before = self.snapshot()
                self.invoke("ingest", "--plan", str(self.plan_file), "--apply", expected=2)
                self.assertEqual(self.snapshot(), before)
        change = self.change("知识/入口.md", page("入口", "[[00-总览]]"))
        change["expected_sha256"] = "invalid-hash"
        self.plan([change])
        self.invoke("ingest", "--plan", str(self.plan_file), expected=2)

    def test_malformed_plans_and_missing_rules_are_rejected(self):
        for raw in ("{", "[]", '{"version": true}', '{"version": 2}'):
            with self.subTest(raw=raw):
                self.plan_file.write_text(raw)
                self.invoke("ingest", "--plan", str(self.plan_file), expected=2)
        self.new_knowledge()
        (self.vault / "AGENTS.md").unlink()
        self.invoke("ingest", "--plan", str(self.plan_file), "--apply", expected=2)

    def test_replacing_old_broken_link_with_different_broken_link_is_new_error(self):
        self.write("知识/入口.md", page("入口", "[[old-missing]] [[00-总览]]"))
        self.plan([self.change("知识/入口.md", page("入口", "[[new-missing]] [[00-总览]]"))])
        before = self.snapshot()
        self.invoke("ingest", "--plan", str(self.plan_file), "--apply", expected=1)
        self.assertEqual(self.snapshot(), before)

    def test_incoming_links_are_checked_when_target_heading_changes(self):
        self.write("知识/引用.md", page("引用", "[[知识/入口#内容]]"))
        self.plan([self.change("知识/入口.md", page("入口", "[[00-总览]]").replace("## 内容", "## 新标题"))])
        failure = self.invoke("ingest", "--plan", str(self.plan_file), "--apply", expected=1)
        self.assertTrue(any(finding["file"] == "知识/引用.md" and finding["check"] == "broken-anchor" for finding in failure["new_errors"]))

    def test_frontmatter_credentials_and_private_keys_are_not_exposed(self):
        content = page("泄漏", "-----BEGIN RSA PRIVATE KEY-----\nprivate-key-body\n-----END RSA PRIVATE KEY-----\n[[入口]]")
        content = content.replace("tags: [wiki]", "tags: [wiki]\ntoken: hidden-token")
        self.write("知识/泄漏.md", content)
        report = self.invoke("lint", "知识/泄漏.md", expected=1)
        self.assertTrue(any(item["check"] == "credential-leak" for item in report["findings"]))
        self.assertNotIn("hidden-token", json.dumps(report))
        self.assertFalse(any("_identity" in item for item in report["findings"]))
        read = self.invoke("read", "知识/泄漏.md")
        self.assertNotIn("private-key-body", read["content"])
        self.assertNotIn("hidden-token", read["content"])

    def test_symlink_write_and_duplicate_paths_are_rejected(self):
        outside = self.workspace / "outside"
        outside.mkdir()
        (self.vault / "linked").symlink_to(outside, target_is_directory=True)
        self.plan([{"path": "linked/page.md", "expected_sha256": None, "content": page("Page", "[[入口]]")}])
        self.invoke("ingest", "--plan", str(self.plan_file), "--apply", expected=2)
        self.assertEqual(list(outside.iterdir()), [])
        change = self.change("知识/入口.md", page("入口", "[[00-总览]]"))
        self.plan([change, change])
        self.invoke("ingest", "--plan", str(self.plan_file), expected=2)

    def test_lint_templates_links_code_exclusion_and_redaction(self):
        self.write("知识/坏页.md", "---\ntags: []\nlast_updated: invalid\n---\n# 坏页\n\n## 内容\n\n[[missing]]\npassword = hidden-value\n\n## 空章节\n")
        self.write("知识/代码.md", page("代码", "[[入口]]\n```md\n[[not-a-link]]\n```\n`[[not-a-link-either]]`"))
        report = self.invoke("lint", expected=1)
        checks = {finding["check"] for finding in report["findings"]}
        self.assertTrue({"frontmatter", "broken-link", "empty-section", "credential-leak"}.issubset(checks))
        self.assertNotIn("hidden-value", json.dumps(report))
        self.assertFalse(any(finding["file"] == "知识/代码.md" and finding["check"] == "broken-link" for finding in report["findings"]))
        filtered = self.invoke("lint", "知识/坏页.md", expected=1)
        self.assertTrue(all(finding["file"] == "知识/坏页.md" for finding in filtered["findings"]))

    def test_wikilink_anchors_attachments_ambiguity_and_qualified_paths(self):
        self.write("attachments/image.png", "image")
        self.write("其他/入口.md", page("入口", "[[00-总览]]"))
        self.write("知识/链接.md", page("链接", "[[知识/入口#内容|显示名]] ![[attachments/image.png]] [[#内容]]\n[[入口]] [[不存在/入口]] [[知识/入口#不存在]]"))
        report = self.invoke("lint", "知识/链接.md", expected=1)
        checks = [finding["check"] for finding in report["findings"]]
        self.assertIn("ambiguous-link", checks)
        self.assertIn("broken-link", checks)
        self.assertIn("broken-anchor", checks)

    def test_vault_linter_is_used_for_preview_and_apply(self):
        backend = """import argparse, json
from pathlib import Path
parser = argparse.ArgumentParser()
parser.add_argument('--vault')
parser.add_argument('--json', action='store_true')
parser.add_argument('--max-age-days')
args = parser.parse_args()
findings = []
for target in Path(args.vault).rglob('*.md'):
    if 'backend-rejected' in target.read_text():
        findings.append(dict(check='custom-rule', level='error', file=str(target.relative_to(args.vault)), line=1, rule='vault', message='Rejected by vault policy'))
print(json.dumps(dict(findings=findings)))
raise SystemExit(bool(findings))
"""
        self.write(".tools/wiki-lint.py", backend)
        self.assertEqual(self.invoke("lint")["backend"], "vault")
        self.plan([self.change("知识/入口.md", page("入口", "backend-rejected [[00-总览]]"))])
        before = self.snapshot()
        failure = self.invoke("ingest", "--plan", str(self.plan_file), "--apply", expected=1)
        self.assertEqual(failure["new_errors"][0]["check"], "custom-rule")
        self.assertEqual(self.snapshot(), before)

    def test_broken_vault_linter_fails_without_fallback_or_leaking_output(self):
        self.write(".tools/wiki-lint.py", "print('password = backend-secret')\nraise SystemExit(1)\n")
        failure = self.invoke("lint", expected=4)
        self.assertNotIn("backend-secret", json.dumps(failure))
        self.assertIn("invalid JSON", failure["error"])

    def test_post_write_lint_failure_rolls_back_the_batch(self):
        counter = self.workspace / "backend-count"
        backend = """import argparse, json, os
from pathlib import Path
parser = argparse.ArgumentParser()
parser.add_argument('--vault')
parser.add_argument('--json', action='store_true')
parser.add_argument('--max-age-days')
args = parser.parse_args()
counter = Path(os.environ['WIKI_TEST_BACKEND_COUNTER'])
count = int(counter.read_text()) + 1 if counter.exists() else 1
counter.write_text(str(count))
findings = [dict(check='post-write', level='error', file='知识/入口.md', line=1, rule='vault', message='Injected post-write failure')] if count == 3 else []
print(json.dumps(dict(findings=findings)))
raise SystemExit(bool(findings))
"""
        self.write(".tools/wiki-lint.py", backend)
        self.new_knowledge()
        before = self.snapshot()
        failure = self.invoke("ingest", "--plan", str(self.plan_file), "--apply", expected=1, environment={"WIKI_TEST_BACKEND_COUNTER": str(counter)})
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(len(failure["restored"]), 3)
        self.addCleanup(lambda: shutil.rmtree(failure["recovery"], ignore_errors=True))

    def test_plan_stdin_and_existing_file_must_not_be_recreated(self):
        document = self.new_knowledge()
        self.assertEqual(self.invoke("ingest", "--plan", "-", stdin=json.dumps(document))["status"], "preview")
        document["changes"][1]["expected_sha256"] = None
        self.plan_file.write_text(json.dumps(document))
        self.invoke("ingest", "--plan", str(self.plan_file), "--apply", expected=3)

    def test_partial_write_failure_restores_originals(self):
        specification = importlib.util.spec_from_file_location("wiki_under_test", CLI)
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        document = self.new_knowledge()
        document["changes"][:2] = reversed(document["changes"][:2])
        self.plan_file.write_text(json.dumps(document))
        before = self.snapshot()
        original_replace = os.replace
        replacements = 0

        def fail_second_write(source, destination):
            nonlocal replacements
            if Path(destination).is_relative_to(self.vault):
                replacements += 1
                if replacements == 2:
                    raise OSError("injected write failure")
            return original_replace(source, destination)

        output = io.StringIO()
        with patch.object(module.os, "replace", fail_second_write), contextlib.redirect_stdout(output):
            exit_code = module.main(["ingest", "--vault", str(self.vault), "--plan", str(self.plan_file), "--apply", "--json"])
        self.assertEqual(exit_code, 4)
        failure = json.loads(output.getvalue())
        self.assertEqual(self.snapshot(), before)
        recovery = Path(failure["recovery"])
        self.addCleanup(lambda: shutil.rmtree(recovery, ignore_errors=True))
        self.assertTrue((recovery / "recovery.json").is_file())
        self.assertEqual((recovery / "originals/0").read_bytes(), before["知识/入口.md"])
        self.assertEqual(failure["unrestored"], [])

    def test_failure_does_not_rollback_over_an_intervening_edit(self):
        specification = importlib.util.spec_from_file_location("wiki_concurrent_test", CLI)
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        document = self.new_knowledge()
        document["changes"][:2] = reversed(document["changes"][:2])
        self.plan_file.write_text(json.dumps(document))
        original_replace = os.replace
        human_content = page("入口", "人工同时编辑。[[00-总览]]")
        replacements = 0

        def edit_then_fail(source, destination):
            nonlocal replacements
            if Path(destination).is_relative_to(self.vault):
                replacements += 1
                if replacements == 2:
                    self.write("知识/入口.md", human_content)
                    raise OSError("injected failure after concurrent edit")
            return original_replace(source, destination)

        output = io.StringIO()
        with patch.object(module.os, "replace", edit_then_fail), contextlib.redirect_stdout(output):
            exit_code = module.main(["ingest", "--vault", str(self.vault), "--plan", str(self.plan_file), "--apply", "--json"])
        self.assertEqual(exit_code, 4)
        failure = json.loads(output.getvalue())
        self.addCleanup(lambda: shutil.rmtree(failure["recovery"], ignore_errors=True))
        self.assertEqual(failure["unrestored"], ["知识/入口.md"])
        self.assertEqual((self.vault / "知识/入口.md").read_text(), human_content)
        self.assertFalse((self.vault / "知识/新知识.md").exists())


if __name__ == "__main__":
    unittest.main()
