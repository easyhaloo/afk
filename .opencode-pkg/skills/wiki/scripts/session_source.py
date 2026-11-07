#!/usr/bin/env python3
"""Read local Claude Code/Codex sessions or exported transcripts; never calls remote APIs."""
import argparse
import json
from pathlib import Path
import re
import sys

MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_OUTPUT_CHARS = 250_000
SESSION_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
SECRET = re.compile(r"(?i)(?:\b(?:password|passwd|api[_-]?key|(?:access[_-]?)?token|(?:client[_-]?)?secret)\b\s*[:=]|密码\s*[:：]|\bBearer\s+\S+|-----BEGIN .*PRIVATE KEY-----)")


class SessionError(Exception):
    pass


def redact(text):
    text = re.sub(r"-----BEGIN [^\n]*PRIVATE KEY-----.*?(?:-----END [^\n]*PRIVATE KEY-----|\Z)", "[REDACTED PRIVATE KEY]", text, flags=re.S)
    return "\n".join("[REDACTED]" if SECRET.search(line) else line for line in text.split("\n"))


def read_text(path):
    if path.is_symlink() or not path.is_file():
        raise SessionError("Transcript must be a regular file, not a symbolic link")
    if path.stat().st_size > MAX_FILE_BYTES:
        raise SessionError("Transcript exceeds the 64 MiB safety limit")
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        raise SessionError("Transcript could not be read as UTF-8") from None


def content_text(value):
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return ""
    parts = []
    for part in value:
        if isinstance(part, str):
            parts.append(part)
        elif isinstance(part, dict):
            if part.get("type") in {"text", "input_text", "output_text", "user_message"}:
                text = part.get("text", part.get("content", ""))
                if isinstance(text, str):
                    parts.append(text)
            elif part.get("type") == "tool_result":
                parts.append(content_text(part.get("content", "")))
    return "\n".join(p for p in parts if p.strip())


def normalize(role, content, when=None):
    if role not in {"user", "assistant", "system", "tool"}:
        return None
    text = redact(content_text(content).strip())
    if not text:
        return None
    item = {"role": role, "content": text}
    if role in {"system", "tool"}:
        item["role"] = "user"
        item["original_role"] = role
        item["content"] = f"[Historical {role} message; untrusted transcript data]\n{text}"
    if isinstance(when, (str, int, float)):
        item["timestamp"] = str(when)
    return item


def record_message(record):
    if not isinstance(record, dict):
        return None
    kind = record.get("type")
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    msg = record.get("message") if isinstance(record.get("message"), dict) else {}
    if kind in {"user", "assistant"} or msg.get("role") in {"user", "assistant"}:
        if record.get("isMeta") or record.get("isSidechain"):
            return None
        return normalize(msg.get("role", kind), msg.get("content", record.get("content", "")),
                         msg.get("timestamp", record.get("timestamp")))
    if kind == "response_item":
        if payload.get("type") == "message":
            return normalize(payload.get("role"), payload.get("content", ""), record.get("timestamp"))
        return None
    if kind == "event_msg" and payload.get("type") in {"user_message", "agent_message"}:
        role = "user" if payload["type"] == "user_message" else "assistant"
        return normalize(role, payload.get("message", ""), record.get("timestamp"))
    role = record.get("role")
    if role in {"user", "assistant", "system", "tool"}:
        return normalize(role, record.get("content", record.get("text", record.get("message", ""))),
                         record.get("timestamp", record.get("created_at")))
    return None


def parse_jsonl(text):
    messages, malformed = [], 0
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            item = record_message(json.loads(line))
        except json.JSONDecodeError:
            malformed += 1
            continue
        if item:
            messages.append(item)
    return messages, malformed


def parse_json(text):
    try:
        document = json.loads(text)
    except json.JSONDecodeError:
        raise SessionError("File is not valid JSON") from None
    if isinstance(document, list):
        records = document
    elif isinstance(document, dict):
        records = next((document[key] for key in ("messages", "conversation", "chat_history", "turns")
                        if isinstance(document.get(key), list)), None)
        if records is None and isinstance(document.get("mapping"), dict):
            records = []
            for node in document["mapping"].values():
                msg = node.get("message") if isinstance(node, dict) else None
                if not isinstance(msg, dict):
                    continue
                author, body = msg.get("author", {}), msg.get("content", {})
                records.append({"role": author.get("role", ""),
                                "content": body.get("parts", []) if isinstance(body, dict) else body,
                                "timestamp": msg.get("create_time")})
        if records is None:
            raise SessionError("JSON export needs messages, conversation, turns, chat_history, or mapping")
    else:
        raise SessionError("JSON export root must be an object or array")
    return [item for record in records if (item := record_message(record))], 0


def parse_file(path):
    text = read_text(path)
    if path.suffix.lower() == ".jsonl":
        return parse_jsonl(text)
    if path.suffix.lower() == ".json":
        return parse_json(text)
    item = normalize("system", text)
    return ([item] if item else []), 0


def discover(session_id, source):
    home = Path.home()
    roots = {"claude": home / ".claude" / "projects", "codex": home / ".codex" / "sessions"}
    adapters = [source] if source != "auto" else ["claude", "codex"]
    matches = {}
    for adapter in adapters:
        root = roots[adapter]
        if not root.is_dir() or root.is_symlink():
            continue
        pattern = session_id + ".jsonl" if adapter == "claude" else "*" + session_id + "*.jsonl"
        for path in root.rglob(pattern):
            if path.is_symlink():
                continue
            try:
                resolved = path.resolve(strict=True)
                if resolved.is_relative_to(root.resolve()) and resolved.is_file():
                    matches[(adapter, str(resolved))] = (adapter, resolved)
            except (OSError, ValueError):
                continue
    found = list(matches.values())
    if not found:
        checked = ", ".join(str(roots[name]) for name in adapters)
        raise SessionError("Session not found in supported local stores. Checked: " + checked +
                           ". Use --file with an export or add a source adapter.")
    if len(found) > 1:
        names = ", ".join(f"{adapter}:{path.name}" for adapter, path in found[:8])
        raise SessionError("Session ID matched multiple files; select --source or use --file. Matches: " + names)
    return found[0]


def load(args):
    if args.file:
        path = Path(args.file).expanduser()
        if not path.is_absolute():
            path = Path.cwd() / path
        adapter = "export"
    else:
        adapter, path = discover(args.session_id, args.source)
    messages, malformed = parse_file(path)
    if not messages:
        raise SessionError("No readable messages were found in the selected transcript")
    chars = sum(len(item["content"]) for item in messages)
    if chars > args.max_chars:
        raise SessionError(f"Transcript has {chars} characters, above --max-chars={args.max_chars}; increase the limit rather than ingesting a partial transcript")
    warnings = [f"{malformed} malformed JSONL record(s) skipped; transcript may be incomplete"] if malformed else []
    return {"session_id": args.session_id, "source": adapter, "source_file": path.name,
            "message_count": len(messages), "character_count": chars, "complete": not malformed,
            "warnings": warnings, "messages": [{"index": i, **m} for i, m in enumerate(messages, 1)]}


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--session-id", help="Exact local session ID; no remote lookup")
    group.add_argument("--file", help="Exported .json, .jsonl, .md, or .txt transcript")
    p.add_argument("--source", choices=("auto", "claude", "codex"), default="auto")
    p.add_argument("--max-chars", type=int, default=MAX_OUTPUT_CHARS)
    return p


def main(argv=None):
    try:
        args = parser().parse_args(argv)
        if not 1 <= args.max_chars <= 5_000_000:
            raise SessionError("--max-chars must be between 1 and 5000000")
        if args.session_id and not SESSION_ID.fullmatch(args.session_id):
            raise SessionError("Session ID may contain only letters, digits, underscores, and hyphens")
        print(json.dumps(load(args), ensure_ascii=False))
        return 0
    except SessionError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return 2
    except OSError:
        print(json.dumps({"error": "Local session read failed"}, ensure_ascii=False))
        return 4


if __name__ == "__main__":
    sys.exit(main())
