#!/usr/bin/env python3
"""Validate the structure and common content defects of an approved PRD."""

from __future__ import annotations

import re
import sys
from collections import Counter
from pathlib import Path

REQUIRED_SECTIONS = (
    "## 1. Background & Problem",
    "## 2. Goals & Success Measures",
    "## 3. Users & User Stories",
    "## 4. Scope",
    "## 5. Functional Requirements & Acceptance Criteria",
)
OPTIONAL_SECTIONS = (
    "## 6. Business Rules (when applicable)",
    "## 7. Product Constraints & Quality Requirements (when applicable)",
    "## 8. Related Flow or State Model (optional)",
    "## 9. Confirmed Product Decisions (optional)",
    "## 10. Traceability (optional when needed)",
)
ID_RE = re.compile(r"\b(?:GOAL|USER|FR|AC|BR|NFR|FLOW|SEQ|STATE|RULE)-\d{3}\b")
DEFINED_ID_RE = re.compile(r"^\s*\|\s*(GOAL|USER)-\d{3}\s*\|", re.MULTILINE)
AC_DEFINITION_RE = re.compile(r"\b(AC-\d{3})\s*:")
PLACEHOLDER_RE = re.compile(r"<[^>\n]+>|\b(?:TBD|TODO|Unknown|Proposed)\b|待确认|未确认|待补充|待定|尚未确定", re.IGNORECASE)
CODE_DETAIL_PATTERNS = (
    re.compile(r"\b(?:def|class|function)\s+[A-Za-z_][\w]*\s*\("),
    re.compile(r"\bCREATE\s+TABLE\b", re.IGNORECASE),
    re.compile(r"\b(?:src|lib|internal|backend|frontend)/[\w./-]+\.(?:py|go|ts|tsx|js|jsx|java|sql)\b"),
    re.compile(r"\b[A-Za-z_][\w]*\([^\n)]*\)"),
)


def strip_non_mermaid_code(text: str) -> str:
    """Remove fenced code blocks from prose checks while retaining Mermaid diagrams."""
    def replace(match: re.Match[str]) -> str:
        block = match.group(0)
        if re.match(r"```\s*mermaid\b", block):
            return block
        return "\n" * block.count("\n")

    return re.sub(r"```[^\n]*\n[\s\S]*?```", replace, text)


def section_text(text: str, heading: str) -> str:
    escaped = re.escape(heading)
    match = re.search(rf"^{escaped}\s*$([\s\S]*?)(?=^##\s|\Z)", text, re.MULTILINE)
    return match.group(1) if match else ""


def markdown_table_rows(section: str) -> list[list[str]]:
    rows: list[list[str]] = []
    for line in section.splitlines():
        stripped = line.strip()
        if not (stripped.startswith("|") and stripped.endswith("|")):
            continue
        cells = [cell.strip() for cell in stripped[1:-1].split("|")]
        if cells and all(re.fullmatch(r":?-{3,}:?", cell.replace(" ", "")) for cell in cells):
            continue
        rows.append(cells)
    return rows


def table_data_rows(section: str) -> list[list[str]]:
    rows = markdown_table_rows(section)
    return rows[1:] if len(rows) > 1 else []


def report(errors: list[str], warnings: list[str]) -> int:
    for message in errors:
        print(f"ERROR: {message}")
    for message in warnings:
        print(f"WARNING: {message}")
    if errors:
        print(f"FAIL: {len(errors)} error(s), {len(warnings)} warning(s)")
        return 1
    print(f"PASS: PRD structure/content checks passed with {len(warnings)} warning(s)")
    print("NOTE: Automated checks cannot prove that product decisions were explicitly confirmed.")
    return 0


def validate(path: Path) -> int:
    errors: list[str] = []
    warnings: list[str] = []
    raw = path.read_text(encoding="utf-8")
    text = strip_non_mermaid_code(raw)

    if not re.search(r"^# PRD:\s*\S+", text, re.MULTILINE):
        errors.append("missing PRD title: '# PRD: <title>'")
    if not re.search(r"^\|\s*Status\s*\|\s*Approved\s*\|\s*$", text, re.MULTILINE | re.IGNORECASE):
        errors.append("PRD metadata must declare Status as Approved")

    positions: list[int] = []
    for heading in REQUIRED_SECTIONS:
        position = text.find(heading)
        if position < 0:
            errors.append(f"missing required section: {heading}")
        positions.append(position)
    present = [position for position in positions if position >= 0]
    if present != sorted(present):
        errors.append("required sections are out of order")

    for section in REQUIRED_SECTIONS:
        content = section_text(text, section)
        if content and not content.strip():
            errors.append(f"required section has no content: {section}")

    for heading in OPTIONAL_SECTIONS:
        if heading in text and not section_text(text, heading).strip():
            errors.append(f"optional section is present but empty: {heading}")

    if PLACEHOLDER_RE.search(text):
        matches = sorted({match.group(0) for match in PLACEHOLDER_RE.finditer(text)})
        errors.append("unresolved placeholder or unconfirmed marker remains: " + ", ".join(matches))

    # Formal PRDs may contain Mermaid diagrams, but not code snippets.
    if re.search(r"```(?!\s*mermaid\b)[^\n]*\n", raw):
        errors.append("code fences are not allowed in a PRD; use prose, tables, or Mermaid for product behavior")

    defined_ids: list[str] = []
    for match in DEFINED_ID_RE.finditer(text):
        defined_ids.append(match.group(0).split("|")[1].strip())

    goals = table_data_rows(section_text(text, REQUIRED_SECTIONS[1]))
    users = table_data_rows(section_text(text, REQUIRED_SECTIONS[2]))
    scope = table_data_rows(section_text(text, REQUIRED_SECTIONS[3]))
    requirements = table_data_rows(section_text(text, REQUIRED_SECTIONS[4]))

    if not goals:
        errors.append("Goals & Success Measures must contain at least one goal row")
    if not users:
        errors.append("Users & User Stories must contain at least one user story row")
    if not scope:
        errors.append("Scope must contain at least one scope row")
    if not requirements:
        errors.append("Functional Requirements must contain at least one requirement row")

    for section_name, rows, minimum_cells in (
        ("Goals & Success Measures", goals, 3),
        ("Users & User Stories", users, 4),
        ("Scope", scope, 2),
        ("Functional Requirements & Acceptance Criteria", requirements, 4),
    ):
        for index, row in enumerate(rows, start=1):
            if len(row) < minimum_cells or any(not cell for cell in row[:minimum_cells]):
                errors.append(f"{section_name} row {index} has missing required cells")

    requirement_ids: set[str] = set()
    for index, row in enumerate(requirements, start=1):
        if not row:
            continue
        requirement_id = row[0]
        if not re.fullmatch(r"FR-\d{3}", requirement_id):
            errors.append(f"requirement row {index} must start with an FR-### ID")
            continue
        requirement_ids.add(requirement_id)
        acceptance_cell = row[3] if len(row) > 3 else ""
        criterion_ids = AC_DEFINITION_RE.findall(acceptance_cell)
        if not criterion_ids:
            errors.append(f"{requirement_id} must define at least one AC-### acceptance criterion")
        for criterion_id in criterion_ids:
            if not re.search(r"\bGiven\b", acceptance_cell, re.IGNORECASE):
                errors.append(f"{criterion_id} must state a Given condition")
            if not re.search(r"\bWhen\b", acceptance_cell, re.IGNORECASE):
                errors.append(f"{criterion_id} must state a When action")
            if not re.search(r"\bThen\b", acceptance_cell, re.IGNORECASE):
                errors.append(f"{criterion_id} must state a Then outcome")
        defined_ids.extend([requirement_id, *criterion_ids])

    # IDs in the first column of the other standard tables are definitions.
    for section_heading in OPTIONAL_SECTIONS:
        if section_heading not in text:
            continue
        for row in table_data_rows(section_text(text, section_heading)):
            if row and re.fullmatch(r"(?:BR|NFR|GOAL|USER)-\d{3}", row[0]):
                defined_ids.append(row[0])

    counts = Counter(defined_ids)
    for item, count in sorted(counts.items()):
        if count > 1:
            errors.append(f"duplicate ID definition: {item}")

    defined_ids.extend(re.findall(r"^### ((?:FLOW|SEQ|STATE|RULE)-\d{3}):", text, re.MULTILINE))
    defined = set(defined_ids)
    # Check only standard IDs that are referenced in prose or tables; the definition itself is allowed.
    all_ids = set(ID_RE.findall(text))
    for item in sorted(all_ids - defined):
        errors.append(f"ID reference has no definition: {item}")

    for pattern in CODE_DETAIL_PATTERNS:
        if pattern.search(text):
            warnings.append("possible code-level implementation detail found; review and move it to technical design")
            break

    if re.search(r"\b(?:Assumptions|Open Risks|Open Questions)\b|待澄清|未决问题", text, re.IGNORECASE):
        warnings.append("review for unresolved product decisions; a published PRD must contain confirmed information only")

    if "```mermaid" in raw:
        if not re.search(r"\b(?:FLOW|SEQ|STATE|RULE)-\d{3}\b", raw):
            warnings.append("Mermaid diagram has no related stable diagram ID")

    return report(errors, warnings)


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: validate_prd.py <PRD.md>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    if not path.is_file():
        print(f"ERROR: file not found: {path}", file=sys.stderr)
        return 2
    return validate(path)


if __name__ == "__main__":
    raise SystemExit(main())
