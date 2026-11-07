#!/usr/bin/env python3
"""Run the real Claude Code wiki skill against a disposable fixture vault."""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


SKILL = Path(__file__).resolve().parent.parent
CLI = SKILL / "scripts/wiki.py"


def make_page(title, body, tags="wiki", properties=""):
    today = datetime.date.today().isoformat()
    return f"---\ntags: [{tags}]\nlast_updated: {today}\n{properties}---\n# {title}\n\n## 内容\n\n{body}\n"


def prepare(workspace):
    vault = workspace / "vault"
    vault.mkdir()
    documents = {
        "AGENTS.md": """# Fixture wiki rules
This is a disposable integration-test vault, not company knowledge.
Use Chinese page names. Formal knowledge lives in 知识/; unverified claims
belong only in 99-收件箱/. Read each directory's _模板.md before writing.
Required properties: tags and last_updated; inbox pages also require 类型.
Preserve existing unrelated facts. Update current facts rather than append
changelogs. Every content page must link to a related page, receive a backlink,
and be linked from 00-总览.md. Do not invent evidence or required values.
Only the bundled wiki CLI may change Markdown; use a plan, preview, and apply.
""",
        "00-总览.md": make_page("总览", "[[知识/重试策略]]"),
        "知识/_模板.md": make_page("标题", "填写知识及来源。"),
        "知识/重试策略.md": make_page("重试策略", "最多尝试 3 次。请求必须携带幂等键。\n\n[[00-总览]]"),
        "99-收件箱/_模板.md": make_page("标题", "问题及验证方式。", "收件箱", "类型: 待验证\n"),
    }
    for relative, content in documents.items():
        target = vault / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    evidence = workspace / "evidence.json"
    evidence.write_text(json.dumps({"fixture": True, "verified": True, "max_attempts": 5, "backoff_seconds": [1, 2, 4, 8], "idempotency_required": True}), encoding="utf-8")
    (workspace / ".wiki.json").write_text(json.dumps({"vault": "vault"}), encoding="utf-8")
    return vault


def events_from(path):
    events = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def verify(workspace, events, protected):
    vault = workspace / "vault"
    calls = []
    outputs = []
    for event in events:
        message = event.get("message", {})
        if not isinstance(message, dict):
            continue
        content = message.get("content", [])
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use":
                calls.append(block)
            elif block.get("type") == "tool_result":
                outputs.append(block.get("content", ""))
    if not any(call.get("name") == "Skill" and call.get("input", {}).get("skill") in {"wiki", "afk:wiki"} for call in calls):
        raise AssertionError("Claude did not invoke the wiki Skill tool")
    cli_calls = [call.get("input", {}).get("command", "") for call in calls if call.get("name") == "Bash" and "wiki.py" in call.get("input", {}).get("command", "")]
    for operation in ("locate", "search", "read", "ingest", "lint"):
        if not any(operation in command for command in cli_calls):
            raise AssertionError(f"Claude did not run CLI {operation}")
    if not any("--apply" in command for command in cli_calls):
        raise AssertionError("Claude did not apply an ingest plan")
    if any("--vault" in command or "WIKI_VAULT=" in command for command in cli_calls):
        raise AssertionError("Claude bypassed automatic vault discovery")
    serialized = json.dumps(outputs, ensure_ascii=False)
    for state in ("preview", "applied", "unchanged"):
        if state not in serialized:
            raise AssertionError(f"Missing CLI result state: {state}")
    body = (vault / "知识/重试策略.md").read_text(encoding="utf-8")
    if "5" not in body or "幂等" not in body or "3 次" in body or not ("退避" in body or "backoff" in body):
        raise AssertionError("Confirmed facts were not merged while preserving existing knowledge")
    if "Redis" in re.sub(r"!?\[\[[^\]]+\]\]", "", body):
        raise AssertionError("Unverified Redis claim entered formal knowledge")
    inbox = [target for target in (vault / "99-收件箱").glob("*.md") if not target.name.startswith("_")]
    if not any("Redis" in target.read_text(encoding="utf-8") for target in inbox):
        raise AssertionError("Unverified claim was not captured in the inbox")
    if any("咖啡" in target.read_text(encoding="utf-8") for target in vault.rglob("*.md")):
        raise AssertionError("Transient conversation detail entered the wiki")
    for relative, expected in protected.items():
        if hashlib.sha256((vault / relative).read_bytes()).hexdigest() != expected:
            raise AssertionError("Rules or templates changed")
    for call in calls:
        if call.get("name") in {"Write", "Edit"}:
            changed = call.get("input", {}).get("file_path", "")
            if changed and Path(changed).resolve().is_relative_to(vault):
                raise AssertionError("Claude edited vault files without the CLI")
    environment = dict(os.environ)
    environment.pop("WIKI_VAULT", None)
    checked = subprocess.run([sys.executable, "-B", str(CLI), "lint", "--json"], cwd=workspace, env=environment, capture_output=True, text=True, timeout=60)
    if checked.returncode:
        raise AssertionError("Final CLI lint failed")
    final_events = [event for event in events if event.get("type") == "result"]
    if not final_events or final_events[-1].get("is_error"):
        raise AssertionError("Claude did not finish successfully")
    return {"status": "passed", "skill_invoked": True, "cli_calls": len(cli_calls), "checks": ["automatic vault discovery", "context distillation", "evidence merge", "inbox routing", "transient detail excluded", "preview", "apply", "unchanged replay", "search", "read", "lint"], "lint": json.loads(checked.stdout)["summary"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", help="New directory for the disposable vault and private execution trace")
    parser.add_argument("--timeout", type=int, default=600)
    options = parser.parse_args()
    claude = shutil.which("claude")
    if not claude:
        parser.error("Claude Code must be installed and authenticated")
    link = Path.home() / ".claude/skills/wiki"
    if not link.exists() or link.resolve() != SKILL:
        parser.error("Install a ~/.claude/skills/wiki symlink to this skill before running")
    workspace = Path(options.output).expanduser().resolve() if options.output else Path(tempfile.mkdtemp(prefix="wiki-claude-e2e-")).resolve()
    if options.output:
        workspace.mkdir(mode=0o700, parents=True, exist_ok=False)
    workspace.chmod(0o700)
    vault = prepare(workspace)
    protected = {str(target.relative_to(vault)): hashlib.sha256(target.read_bytes()).hexdigest() for target in vault.rglob("*.md") if target.name == "AGENTS.md" or target.name.startswith("_")}
    prompt = f"""请使用 Skill 工具加载 wiki skill，实际运行它完成下面的集成测试。只操作测试目录 {workspace}，不要访问公司 Wiki 或凭证。Skill 源码目录只读。
工作目录已经配置 .wiki.json。先用 CLI locate 自动发现 Vault；不要传 --vault 或设置 WIKI_VAULT，也不要访问用户默认 Vault。这是合成测试上下文，以下事实均仅适用于该 fixture：
1. 用户已确认：重试策略的最多总尝试次数由 3 次改为 5 次；采用指数退避，四次等待依次为 1、2、4、8 秒。幂等键要求维持不变。
2. 当前工具验证输出在 {workspace / 'evidence.json'}，请读取并作为依据。
3. Redis 是否已经部署没有证据，属于值得追踪的待验证问题，请按 Vault 规则沉淀。
4. 刚喝了一杯咖啡属于临时闲聊，没有长期知识价值。
先按 skill 和 Vault 规则检索、读取现有页面与模板；提炼有效知识并生成 JSON plan，调用 CLI 预览，然后 --apply。允许在测试目录内写计划并更新 Vault，无需再请求确认。
完成后调用 CLI 搜索和读取结果并执行 lint；再次执行同一 plan 的 --apply，验证返回 unchanged。最后删除临时 plan，保留 Vault 和测试证据。不得绕过 CLI 直接编辑 Vault Markdown，不要改源码、规则或模板。报告实际结果。"""
    command = [claude, "--print", "--verbose", "--output-format", "stream-json", "--no-session-persistence", "--settings", '{"disableAllHooks":true}', "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--tools", "Skill,Read,Write,Edit,Glob,Grep,Bash", "--allowedTools", "Skill", "Read", "Write", "Edit", "Glob", "Grep", "Bash(python3 *)", "Bash(rg *)", "Bash(mkdir *)", "Bash(rm *)", "--permission-mode", "dontAsk", "--add-dir", str(SKILL), "--", prompt]
    environment = dict(os.environ)
    environment.pop("WIKI_VAULT", None)
    environment.pop("CLAUDECODE", None)
    transcript = workspace / "claude.ndjson"
    diagnostics = workspace / "claude.stderr"
    print(json.dumps({"status": "running", "workspace": str(workspace)}, ensure_ascii=False), flush=True)
    try:
        with transcript.open("w", encoding="utf-8") as stdout, diagnostics.open("w", encoding="utf-8") as stderr:
            completed = subprocess.run(command, cwd=workspace, env=environment, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, timeout=options.timeout)
        if completed.returncode:
            raise AssertionError(f"Claude exited {completed.returncode}; inspect private trace")
        result = verify(workspace, events_from(transcript), protected)
    except (AssertionError, OSError, subprocess.TimeoutExpired) as error:
        result = {"status": "failed", "error": str(error)}
    result["workspace"] = str(workspace)
    (workspace / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
