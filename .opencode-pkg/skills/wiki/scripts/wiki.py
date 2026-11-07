#!/usr/bin/env python3
"""Local Obsidian wiki operations. Python 3.10+; search uses ripgrep."""

import argparse
from collections import Counter
import csv
import datetime
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile


EXCLUDED = {"node_modules", "30-账户凭证"}
SECRET = re.compile(
    r"(?i)(?:\b(?:password|passwd|api[_-]?key|(?:access[_-]?)?token|(?:client[_-]?)?secret)\b\s*[:=]|密码\s*[:：]|\bBearer\s+\S+|-----BEGIN .*PRIVATE KEY-----)"
)
WIKILINK = re.compile(r"!?\[\[([^\[\]\n]+)\]\]")
HEADING = re.compile(r"^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$")
MAX_PLAN_BYTES = 8 * 1024 * 1024


class WikiError(Exception):
    def __init__(self, message, code=2, **details):
        super().__init__(message)
        self.code = code
        self.details = details


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise WikiError(message)


def digest(content):
    return hashlib.sha256(content).hexdigest()


def resolve_vault(options):
    configured = getattr(options, "vault", None) or os.environ.get("WIKI_VAULT")
    source = "--vault" if getattr(options, "vault", None) else "WIKI_VAULT"
    if not configured:
        directory = Path.cwd()
        project = next((parent / ".wiki.json" for parent in (directory, *directory.parents) if (parent / ".wiki.json").exists()), None)
        user_config = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "wiki/config.json"
        config = project or user_config
        if not config.is_file():
            raise WikiError("Configure a default vault in ~/.config/wiki/config.json or a project .wiki.json; --vault and WIKI_VAULT override it")
        try:
            document = json.loads(config.read_text(encoding="utf-8"))
        except (ValueError, UnicodeError):
            raise WikiError("Invalid wiki configuration JSON: " + str(config)) from None
        if not isinstance(document, dict) or not isinstance(document.get("vault"), str) or not document["vault"].strip():
            raise WikiError("Wiki configuration requires a nonempty vault path: " + str(config))
        configured = Path(document["vault"]).expanduser()
        if not configured.is_absolute():
            configured = config.parent / configured
        source = str(config)
    root = Path(configured).expanduser().resolve()
    if not root.is_dir():
        raise WikiError("Vault directory does not exist", vault_source=source)
    return root, source


def redact(text):
    text = re.sub(r"-----BEGIN [^\n]*PRIVATE KEY-----.*?(?:-----END [^\n]*PRIVATE KEY-----|\Z)", "[REDACTED PRIVATE KEY]", text, flags=re.S)
    return "\n".join("[REDACTED]" if SECRET.search(line) else line for line in text.split("\n"))


def excluded(relative):
    return any(part.startswith(".") or part in EXCLUDED for part in relative.parts)


def safe_path(root, relative, write=False):
    if not isinstance(relative, str) or not relative or "\\" in relative or "\x00" in relative:
        raise WikiError("Expected a vault-relative path")
    path = Path(relative)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in relative.split("/")) or excluded(path):
        raise WikiError("Path is protected or outside the vault")
    if path.suffix != ".md" and write:
        raise WikiError("Ingest only writes Markdown pages")
    if write and (path.name == "AGENTS.md" or path.name.startswith("_")):
        raise WikiError("Ingest cannot modify vault rules or templates")
    target = root / path
    for parent in (target, *target.parents):
        if parent == root:
            break
        if parent.is_symlink():
            raise WikiError("Symbolic links are not allowed")
        if parent != target and parent.exists() and not parent.is_dir():
            raise WikiError("A parent path is not a directory")
    if not target.resolve().is_relative_to(root):
        raise WikiError("Path escapes the vault")
    if write and target.exists() and not target.is_file():
        raise WikiError("Target is not a regular file")
    return target


def vault_files(root):
    for directory, directories, files in os.walk(root, followlinks=False):
        directories[:] = sorted(
            name for name in directories
            if not name.startswith(".") and name != "node_modules" and not (Path(directory) / name).is_symlink()
        )
        for name in sorted(files):
            target = Path(directory) / name
            if not name.startswith(".") and not target.is_symlink() and target.is_file():
                yield target


def frontmatter(text):
    match = re.match(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", text, re.S)
    if not match:
        return {}, 0
    properties = {}
    current = None
    for line in match[1].splitlines():
        field = re.match(r"^([^\s:#][^:]*):\s*(.*?)\s*$", line)
        item = re.match(r"^\s+-\s+(.+?)\s*$", line)
        if field:
            current, value = field.groups()
            if value.startswith("[") and value.endswith("]"):
                properties[current] = [part.strip().strip("\"'") for part in next(csv.reader([value[1:-1]], skipinitialspace=True)) if part.strip()]
            else:
                properties[current] = [value.strip("\"'")] if value else []
        elif item and current:
            properties[current].append(item.group(1).strip("\"'"))
    return properties, text[:match.end()].count("\n")


def sensitive(relative, text):
    properties, _ = frontmatter(text)
    return "30-账户凭证" in Path(relative).parts or "敏感" in properties.get("tags", [])


def pages(root):
    return {target.relative_to(root).as_posix(): target.read_text(encoding="utf-8") for target in vault_files(root) if target.suffix == ".md"}


def note(relative):
    return Path(relative).name != "AGENTS.md" and not Path(relative).name.startswith("_")


def prose_lines(text):
    _, offset = frontmatter(text)
    fence = None
    result = []
    for number, line in enumerate(text.splitlines()):
        boundary = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
        if number < offset:
            result.append("")
        elif boundary:
            marker = boundary.group(1)
            if fence is None:
                fence = marker
            elif marker[0] == fence[0] and len(marker) >= len(fence):
                fence = None
            result.append("")
        elif fence:
            result.append("")
        else:
            result.append(re.sub(r"(`+).*?\1", "", line))
    cleaned = re.sub(r"<!--.*?-->", lambda match: "\n" * match.group().count("\n"), "\n".join(result), flags=re.S)
    return cleaned.split("\n")


def headings(text):
    return [(number, len(match.group(1)), match.group(2)) for number, line in enumerate(prose_lines(text), 1) if (match := HEADING.match(line))]


def read_page(root, arguments):
    target = safe_path(root, arguments.path)
    if target.suffix != ".md" or not target.is_file():
        raise WikiError("Markdown page does not exist")
    content = target.read_bytes()
    text = content.decode("utf-8")
    if sensitive(arguments.path, text):
        raise WikiError("Sensitive pages are excluded")
    start, end = 1, len(text.splitlines())
    if arguments.heading:
        sections = headings(text)
        matches = [(number, level) for number, level, title in sections if title == arguments.heading]
        if len(matches) != 1:
            raise WikiError("Heading is missing or ambiguous")
        start, level = matches[0]
        end = next((number - 1 for number, depth, _ in sections if number > start and depth <= level), end)
        text = "\n".join(text.splitlines()[start - 1:end]) + "\n"
    cleaned = redact(text)
    return {"path": arguments.path, "sha256": digest(content), "line": start, "end_line": end, "content": cleaned, "redacted": cleaned != text}


def search(root, arguments):
    if not arguments.query.strip() or "\n" in arguments.query or len(arguments.query) > 4096:
        raise WikiError("Query must be nonempty, single-line, and at most 4096 characters")
    if not 1 <= arguments.limit <= 1000:
        raise WikiError("Limit must be between 1 and 1000")
    try:
        pattern = re.compile(arguments.query if arguments.regex else re.escape(arguments.query), re.I)
    except re.error:
        raise WikiError("Invalid regular expression") from None
    documents = {relative: text for relative, text in pages(root).items() if note(relative) and not sensitive(relative, text)}
    results = {}
    for relative, text in documents.items():
        properties, _ = frontmatter(text)
        if pattern.search(Path(relative).stem):
            results[relative] = {"path": relative, "line": 1, "heading": Path(relative).stem, "snippet": Path(relative).stem, "matched_by": "title"}
        else:
            aliases = properties.get("aliases", []) + properties.get("alias", [])
            if alias := next((alias for alias in aliases if pattern.search(alias)), None):
                results[relative] = {"path": relative, "line": 1, "heading": Path(relative).stem, "snippet": redact(alias), "matched_by": "alias"}
    executable = shutil.which("rg")
    if not executable:
        raise WikiError("Search requires ripgrep (rg) on PATH")
    command = [executable, "--json", "--ignore-case", "--no-ignore", "--glob", "*.md", "--glob", "!**/30-账户凭证/**", "--glob", "!**/node_modules/**"]
    if not arguments.regex:
        command.append("--fixed-strings")
    result = subprocess.run(command + ["-e", arguments.query, "--", "."], cwd=root, capture_output=True, text=True, timeout=60)
    if result.returncode not in (0, 1):
        raise WikiError("ripgrep rejected the query" if arguments.regex else "ripgrep search failed", 2 if arguments.regex else 4)
    for line in result.stdout.splitlines():
        event = json.loads(line)
        if event["type"] != "match":
            continue
        data = event["data"]
        relative = Path(data["path"].get("text", "")).as_posix().removeprefix("./")
        if relative not in documents or relative in results:
            continue
        number = data["line_number"]
        section = next((title for position, _, title in reversed(headings(documents[relative])) if position <= number), Path(relative).stem)
        results[relative] = {"path": relative, "line": number, "heading": redact(section), "snippet": redact(data["lines"].get("text", "").strip()), "matched_by": "content"}
    priority = {"title": 0, "alias": 1, "content": 2}
    ordered = sorted(results.values(), key=lambda item: (priority[item["matched_by"]], item["path"], item["line"]))
    return {"query": arguments.query, "results": ordered[:arguments.limit], "total": len(ordered)}


def generic_lint(root, max_age_days):
    documents = pages(root)
    files = {target.relative_to(root).as_posix() for target in vault_files(root)}
    by_name = {}
    for relative in files:
        by_name.setdefault(Path(relative).stem if relative.endswith(".md") else Path(relative).name, []).append(relative)
    findings = []

    def add(check, relative, line, message, level="error", identity=""):
        findings.append({"check": check, "level": level, "file": relative, "line": line, "rule": "portable", "message": message, "_identity": identity})

    def resolve(raw, source):
        target, _, anchor = raw.split("|", 1)[0].partition("#")
        if not target:
            return source, anchor, None
        if "\\" in target or ".." in target.split("/") or target.startswith("/"):
            return None, anchor, "broken-link"
        if target.endswith("/"):
            return (target if (root / target).is_dir() and not (root / target).is_symlink() else None), anchor, "broken-link"
        if "/" in target:
            candidates = [target, target + ".md"]
        else:
            candidates = by_name.get(target.removesuffix(".md"), []) or ([target] if target in files else [])
        found = sorted(set(candidate for candidate in candidates if candidate in files))
        return (found[0] if len(found) == 1 else None), anchor, "ambiguous-link" if len(found) > 1 else "broken-link"

    overview = documents.get("00-总览.md")
    indexed = set()
    if overview:
        for match in WIKILINK.finditer("\n".join(prose_lines(overview))):
            destination, _, _ = resolve(match.group(1), "00-总览.md")
            indexed.add(destination)
    for relative, text in sorted(documents.items()):
        if not note(relative) or sensitive(relative, text):
            continue
        properties, offset = frontmatter(text)
        template, _ = frontmatter(documents.get(str(Path(relative).parent / "_模板.md"), ""))
        required = set(template) | {"tags", "last_updated"}
        for field in sorted(required):
            if not properties.get(field) or all(value in {"", "null", "~", "[]"} for value in properties[field]):
                add("frontmatter", relative, 1, "Missing or empty required property: " + field)
        if not set(template.get("tags", [])).issubset(properties.get("tags", [])):
            add("frontmatter", relative, 1, "Tags required by the directory template are missing")
        if properties.get("last_updated"):
            try:
                date = datetime.date.fromisoformat(properties["last_updated"][0])
                age = (datetime.date.today() - date).days
                if age > max_age_days:
                    add("stale-page", relative, 1, f"Page is {age} days old; review its evidence", "warning")
            except ValueError:
                add("frontmatter", relative, 1, "last_updated must be an ISO date")
        lines = prose_lines(text)
        for number, line in enumerate(lines, 1):
            for match in WIKILINK.finditer(line):
                destination, anchor, error = resolve(match.group(1), relative)
                if destination is None:
                    add(error, relative, number, "Wikilink target is missing or ambiguous", identity=match.group(1))
                elif anchor and destination in documents:
                    target_text = documents[destination]
                    valid = (
                        any(re.search(r"\^" + re.escape(anchor[1:]) + r"\s*$", target_line) for target_line in prose_lines(target_text))
                        if anchor.startswith("^") else any(title.casefold() == anchor.casefold() for _, _, title in headings(target_text))
                    )
                    if not valid:
                        add("broken-anchor", relative, number, "Wikilink heading or block is missing", identity=match.group(1))
        sections = headings(text)
        for number, level, _ in sections:
            if level < 2:
                continue
            end = next((position - 1 for position, depth, _ in sections if position > number and depth <= level), len(lines))
            if not any(line.strip(" \t-|:`~") and not HEADING.match(line) for line in text.splitlines()[number:end]):
                add("empty-section", relative, number, "Section has no content")
        for number, line in enumerate(text.splitlines(), 1):
            if SECRET.search(line) and not re.search(r"\[\[|\b(?:see|reference)\b|参见|引用|见|\[REDACTED\]", line, re.I):
                add("credential-leak", relative, number, "Possible credential outside a sensitive page; value omitted", identity=line.strip())
        if overview and relative != "00-总览.md" and relative not in indexed:
            add("not-indexed", relative, 1, "Page is not linked from 00-总览.md")
    return findings


def lint(root, max_age_days=90, backend_root=None):
    if max_age_days < 1:
        raise WikiError("max-age-days must be positive")
    owner = backend_root or root
    backend = owner / ".tools/wiki-lint.py"
    if backend.is_symlink() or backend.parent.is_symlink():
        raise WikiError("Vault linter cannot be a symbolic link")
    if backend.is_file():
        result = subprocess.run([sys.executable, "-B", str(backend), "--vault", str(root), "--max-age-days", str(max_age_days), "--json"], capture_output=True, text=True, timeout=60)
        try:
            report = json.loads(result.stdout)
            findings = report["findings"]
            if result.returncode not in (0, 1) or not isinstance(findings, list):
                raise ValueError
            for finding in findings:
                if not isinstance(finding, dict) or not all(key in finding for key in ("check", "level", "file", "line", "message")):
                    raise ValueError
                if finding["level"] not in {"error", "warning"} or not all(isinstance(finding[key], str) for key in ("check", "file", "message")) or not isinstance(finding.get("rule", ""), str) or type(finding["line"]) is not int or finding["line"] < 1:
                    raise ValueError
            if result.returncode != int(any(item["level"] == "error" for item in findings)):
                raise ValueError
        except (ValueError, KeyError, TypeError):
            raise WikiError("Vault linter failed or returned invalid JSON; output withheld", 4) from None
        backend_name = "vault"
    else:
        findings = generic_lint(root, max_age_days)
        backend_name = "portable"
    return {"backend": backend_name, "findings": sorted(findings, key=lambda item: (item["file"], item["line"], item["check"]))}


def lint_summary(findings):
    return {"error": sum(item["level"] == "error" for item in findings), "warning": sum(item["level"] == "warning" for item in findings)}


def new_errors(before, after):
    def key(item):
        return tuple(item.get(field, "") for field in ("file", "check", "rule", "message", "_identity"))
    existing = Counter(key(item) for item in before if item["level"] == "error")
    introduced = []
    for item in after:
        if item["level"] != "error":
            continue
        identity = key(item)
        if existing[identity]:
            existing[identity] -= 1
        else:
            introduced.append(item)
    return introduced


def load_plan(root, filename):
    with context_plan_input(filename) as stream:
        raw = stream.read(MAX_PLAN_BYTES + 1)
    if len(raw) > MAX_PLAN_BYTES:
        raise WikiError("Plan exceeds 8 MiB")
    try:
        plan = json.loads(raw)
    except (ValueError, UnicodeError):
        raise WikiError("Plan is not valid UTF-8 JSON") from None
    if not isinstance(plan, dict) or type(plan.get("version")) is not int or plan["version"] != 1:
        raise WikiError("Plan version must be 1")
    if set(plan) != {"version", "summary", "evidence", "changes"}:
        raise WikiError("Plan requires exactly version, summary, evidence, and changes")
    if not isinstance(plan["summary"], str) or not plan["summary"].strip():
        raise WikiError("Plan needs a nonempty knowledge summary")
    if not isinstance(plan["evidence"], list) or not plan["evidence"] or not all(isinstance(item, str) and item.strip() for item in plan["evidence"]):
        raise WikiError("Plan needs nonempty evidence references from the current context")
    if not isinstance(plan["changes"], list) or not plan["changes"]:
        raise WikiError("Plan needs at least one change")
    changes = []
    seen = set()
    for change in plan["changes"]:
        if not isinstance(change, dict) or set(change) != {"path", "expected_sha256", "content"}:
            raise WikiError("Each change needs exactly path, expected_sha256, and content")
        target = safe_path(root, change["path"], write=True)
        relative = target.relative_to(root).as_posix()
        if relative.casefold() in seen:
            raise WikiError("Plan contains duplicate paths")
        seen.add(relative.casefold())
        expected = change["expected_sha256"]
        if expected is not None and (not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected)):
            raise WikiError("expected_sha256 must be a lowercase SHA-256 or null for creation")
        if not isinstance(change["content"], str) or not change["content"].strip() or "\x00" in change["content"]:
            raise WikiError("Page content must be nonempty text without NUL bytes")
        if sensitive(relative, change["content"]):
            raise WikiError("Ingest does not write sensitive pages")
        original = target.read_bytes() if target.is_file() else None
        if original is not None and sensitive(relative, original.decode("utf-8")):
            raise WikiError("Ingest does not modify sensitive pages")
        desired = change["content"].encode("utf-8")
        if original != desired and (digest(original) if original is not None else None) != expected:
            raise WikiError("Page changed since the plan was prepared: " + relative, 3)
        changes.append({"path": relative, "before": original, "after": desired, "mode": stat.S_IMODE(target.stat().st_mode) if original is not None else 0o600})
    return changes


def context_plan_input(filename):
    if filename == "-":
        import contextlib
        return contextlib.nullcontext(sys.stdin.buffer)
    return open(filename, "rb")


def verify_current(root, changes):
    for change in changes:
        target = safe_path(root, change["path"], write=True)
        actual = target.read_bytes() if target.is_file() else None
        if actual != change["before"]:
            raise WikiError("Concurrent modification: " + change["path"], 3)


def replace_file(target, content, mode):
    descriptor, filename = tempfile.mkstemp(prefix=".wiki-", suffix=".tmp", dir=target.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), mode)
        os.replace(filename, target)
    finally:
        if os.path.exists(filename):
            os.unlink(filename)


def apply_changes(root, changes, baseline, max_age_days):
    recovery = Path(tempfile.mkdtemp(prefix="wiki-recovery-"))
    originals = recovery / "originals"
    originals.mkdir()
    receipt = {"vault": str(root), "changes": [], "applied": [], "restored": [], "unrestored": []}
    directories = []
    for number, change in enumerate(changes):
        saved = str(number) if change["before"] is not None else None
        if saved is not None:
            (originals / saved).write_bytes(change["before"])
            (originals / saved).chmod(0o600)
        receipt["changes"].append({"path": change["path"], "original": saved, "after_sha256": digest(change["after"]), "mode": change["mode"]})
    receipt_path = recovery / "recovery.json"
    receipt_path.write_text(json.dumps(receipt, ensure_ascii=False), encoding="utf-8")
    try:
        verify_current(root, changes)
        for change in changes:
            target = safe_path(root, change["path"], write=True)
            verify_current(root, [change])
            missing = []
            parent = target.parent
            while not parent.exists():
                missing.append(parent)
                parent = parent.parent
            for directory in reversed(missing):
                directory.mkdir()
                directories.append(directory)
            replace_file(target, change["after"], change["mode"])
            receipt["applied"].append(change["path"])
        final_report = lint(root, max_age_days)
        introduced = new_errors(baseline["findings"], final_report["findings"])
        if introduced:
            raise WikiError("New lint errors appeared after writing", 1, new_errors=introduced)
    except (Exception, KeyboardInterrupt) as error:
        for change in reversed(changes):
            if change["path"] not in receipt["applied"]:
                continue
            try:
                target = safe_path(root, change["path"], write=True)
                if not target.is_file() or target.read_bytes() != change["after"]:
                    raise WikiError("Concurrent change prevents rollback", 3)
                if change["before"] is None:
                    target.unlink()
                else:
                    replace_file(target, change["before"], change["mode"])
                receipt["restored"].append(change["path"])
            except (OSError, WikiError):
                receipt["unrestored"].append(change["path"])
        for directory in reversed(directories):
            try:
                directory.rmdir()
            except OSError:
                pass
        receipt_path.write_text(json.dumps(receipt, ensure_ascii=False), encoding="utf-8")
        details = error.details if isinstance(error, WikiError) else {}
        raise WikiError("Write failed; inspect the recovery receipt before retrying", error.code if isinstance(error, WikiError) else 4, recovery=str(recovery), applied=receipt["applied"], restored=receipt["restored"], unrestored=receipt["unrestored"], **details) from None
    shutil.rmtree(recovery)
    return final_report


def ingest(root, arguments):
    if not (root / "AGENTS.md").is_file() or (root / "AGENTS.md").is_symlink():
        raise WikiError("Ingest requires a regular AGENTS.md defining vault rules")
    changes = load_plan(root, arguments.plan)
    pending = [change for change in changes if change["before"] != change["after"]]
    baseline = lint(root, arguments.max_age_days)
    diffs = [{"path": change["path"], "status": "update" if change["before"] is not None else "create", "diff": redact("".join(difflib.unified_diff((change["before"] or b"").decode("utf-8").splitlines(keepends=True), change["after"].decode("utf-8").splitlines(keepends=True), fromfile=change["path"], tofile=change["path"])))} for change in pending]
    if not pending:
        verify_current(root, changes)
        return {"status": "unchanged", "changes": [], "applied": [], "lint": {**baseline, "summary": lint_summary(baseline["findings"])}}
    with tempfile.TemporaryDirectory(prefix="wiki-preview-") as temporary:
        candidate = Path(temporary) / "candidate"
        candidate.mkdir()
        for target in vault_files(root):
            destination = candidate / target.relative_to(root)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, destination)
        for change in pending:
            target = candidate / change["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(change["after"])
        checked = lint(candidate, arguments.max_age_days, backend_root=root)
    introduced = new_errors(baseline["findings"], checked["findings"])
    if introduced:
        raise WikiError("Plan introduces lint errors; vault was not changed", 1, new_errors=introduced)
    verify_current(root, changes)
    if not arguments.apply:
        return {"status": "preview", "changes": diffs, "applied": [], "new_errors": [], "lint": {**checked, "summary": lint_summary(checked["findings"])}}
    checked = apply_changes(root, pending, baseline, arguments.max_age_days)
    return {"status": "applied", "changes": diffs, "applied": [change["path"] for change in pending], "new_errors": [], "lint": {**checked, "summary": lint_summary(checked["findings"])}}


def parser():
    common = Parser(add_help=False)
    common.add_argument("--vault", default=argparse.SUPPRESS, help="Override WIKI_VAULT, nearest .wiki.json, or user wiki/config.json")
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="Machine-readable JSON on stdout")
    result = Parser(description=__doc__, parents=[common])
    commands = result.add_subparsers(dest="command", required=True, parser_class=Parser)
    commands.add_parser("locate", parents=[common], help="Show the automatically resolved vault and configuration source")
    find = commands.add_parser("search", parents=[common], help="Search page titles, aliases, and content")
    find.add_argument("query")
    find.add_argument("--regex", action="store_true", help="Interpret query as a regular expression")
    find.add_argument("--limit", type=int, default=10)
    read = commands.add_parser("read", parents=[common], help="Read a page with its current SHA-256")
    read.add_argument("path")
    read.add_argument("--heading", help="Read a single uniquely named section")
    check = commands.add_parser("lint", parents=[common], help="Run vault-local or portable checks")
    check.add_argument("path", nargs="?")
    check.add_argument("--max-age-days", type=int, default=90)
    write = commands.add_parser("ingest", parents=[common], help="Preview or apply a context-derived JSON plan")
    write.add_argument("--plan", required=True, help="UTF-8 JSON file, or - for stdin")
    write.add_argument("--apply", action="store_true", help="Write after checking hashes and candidate lint")
    write.add_argument("--max-age-days", type=int, default=90)
    return result


def emit(payload, as_json):
    def clean(value):
        if isinstance(value, str):
            return redact(value)
        if isinstance(value, list):
            return [clean(item) for item in value]
        if isinstance(value, dict):
            return {key: clean(item) for key, item in value.items() if not key.startswith("_")}
        return value
    payload = clean(payload)
    if as_json:
        print(json.dumps(payload, ensure_ascii=False))
    elif "error" in payload:
        print(redact(payload["error"]))
        if "recovery" in payload:
            print("Recovery: " + payload["recovery"])
    elif "results" in payload:
        for item in payload["results"]:
            print(f"{item['path']}:{item['line']} [{item['matched_by']}] {item['snippet']}")
        print(f"{len(payload['results'])} of {payload['total']} matching pages")
    elif "content" in payload:
        print(f"{payload['path']}:{payload['line']} sha256={payload['sha256']}")
        print(payload["content"], end="")
    elif "status" in payload:
        print(payload["status"])
        for change in payload["changes"]:
            print(change["diff"], end="")
    elif "findings" not in payload and "vault" in payload:
        print(payload["vault"])
        print("Source: " + payload["vault_source"])
    else:
        for item in payload["findings"]:
            print(redact(f"{item['file']}:{item['line']} [{item['level']} {item['check']}] {item['message']}"))
        print(f"{payload['summary']['error']} errors, {payload['summary']['warning']} warnings ({payload['backend']})")


def main(argv=None):
    arguments = sys.argv[1:] if argv is None else argv
    as_json = "--json" in arguments
    try:
        options = parser().parse_args(arguments)
        root, source = resolve_vault(options)
        code = 0
        if options.command == "locate":
            payload = {}
        elif options.command == "search":
            payload = search(root, options)
        elif options.command == "read":
            payload = read_page(root, options)
        elif options.command == "ingest":
            payload = ingest(root, options)
        else:
            selected = safe_path(root, options.path) if options.path else None
            if selected is not None and not selected.exists():
                raise WikiError("Lint path does not exist")
            payload = lint(root, options.max_age_days)
            if selected is not None:
                payload["findings"] = [item for item in payload["findings"] if (root / item["file"]) == selected or (root / item["file"]).is_relative_to(selected)]
            payload["summary"] = lint_summary(payload["findings"])
            code = int(payload["summary"]["error"] > 0)
        emit({**payload, "vault": str(root), "vault_source": source}, as_json)
        return code
    except WikiError as error:
        emit({"error": str(error), **error.details}, as_json)
        return error.code
    except (OSError, UnicodeError, subprocess.TimeoutExpired) as error:
        emit({"error": "Local operation failed: " + type(error).__name__}, as_json)
        return 4


if __name__ == "__main__":
    sys.exit(main())
