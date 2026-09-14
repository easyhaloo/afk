#!/usr/bin/env python3
"""Validate the structural contract of an AI-Friendly Markdown PRD."""

from __future__ import annotations

import re
import sys
from pathlib import Path


REQUIRED_SECTIONS = [
    "## 1. Problem Statement",
    "## 2. Goals",
    "## 3. Non-Goals",
    "## 4. Users & Jobs",
    "## 5. Domain Glossary",
    "## 6. Functional Requirements",
    "## 10. Non-Functional Requirements",
    "## 11. Technical Constraints & Decisions",
    "## 12. Key Decisions",
    "## 13. Assumptions",
    "## 14. Open Risks",
    "## 15. Traceability",
    "## 16. Change Log",
]

ID_PATTERN = re.compile(r"\b(?:PRD|GOAL|USER|FR|AC|NFR|DEC|ASM|RISK|FLOW|SEQ|STATE|RULE)-\d{3}\b")
ITEM_PATTERN = re.compile(
    r"^### (?:GOAL|USER|FR|NFR|DEC|ASM|RISK|FLOW|SEQ|STATE|RULE)-\d{3}:",
    re.MULTILINE,
)
FR_PATTERN = re.compile(r"^### (FR-\d{3}):", re.MULTILINE)
AC_PATTERN = re.compile(r"^##### (AC-\d{3}):", re.MULTILINE)
MERMAID_PATTERN = re.compile(r"```mermaid\b")
VAGUE_TERMS = (
    "适当",
    "合理",
    "尽快",
    "简单",
    "友好",
    "高效",
    "稳定可靠",
    "支持各种",
    "按现有逻辑",
    "等等",
    "TBD",
    "TODO",
)


def section_text(text: str, heading: str) -> str:
    match = re.search(
        rf"^{re.escape(heading)}\s*$([\s\S]*?)(?=^## |\Z)", text, re.MULTILINE
    )
    return match.group(1) if match else ""


def report(errors: list[str], warnings: list[str]) -> int:
    for message in errors:
        print(f"ERROR: {message}")
    for message in warnings:
        print(f"WARNING: {message}")
    if errors:
        print(f"FAIL: {len(errors)} error(s), {len(warnings)} warning(s)")
        return 1
    print(f"PASS: structural self-check passed with {len(warnings)} warning(s)")
    return 0


def validate(path: Path) -> int:
    errors: list[str] = []
    warnings: list[str] = []
    text = path.read_text(encoding="utf-8")

    positions = []
    for heading in REQUIRED_SECTIONS:
        position = text.find(heading)
        if position < 0:
            errors.append(f"missing required section: {heading}")
        positions.append(position)
    present_positions = [position for position in positions if position >= 0]
    if present_positions != sorted(present_positions):
        errors.append("required sections are out of order")

    ids = ID_PATTERN.findall(text)
    duplicates = sorted({item for item in ids if ids.count(item) > 1})
    for item in duplicates:
        warnings.append(f"ID appears multiple times; verify whether references are intended: {item}")

    for section in ("## 2. Goals", "## 6. Functional Requirements"):
        if not section_text(text, section).strip():
            errors.append(f"section has no content: {section}")

    requirements = list(FR_PATTERN.finditer(text))
    if not requirements:
        errors.append("no functional requirement headings found")

    for index, match in enumerate(requirements):
        requirement_id = match.group(1)
        end = requirements[index + 1].start() if index + 1 < len(requirements) else len(text)
        block = text[match.start() : end]
        required_labels = (
            "**Confidence**",
            "**Priority**",
            "**Surface**",
            "**Related Goal**",
            "**Actor**",
            "**Bounded Context**",
            "**Trigger**",
            "#### Product Promise",
            "#### Preconditions",
            "#### Main Flow",
            "#### Abnormal Flows",
            "#### Completion Conditions",
            "#### Invariants",
            "#### Acceptance Criteria",
        )
        for label in required_labels:
            if label not in block:
                errors.append(f"{requirement_id} missing: {label}")
        if not AC_PATTERN.search(block):
            errors.append(f"{requirement_id} has no acceptance criterion")

    acceptance_criteria = list(AC_PATTERN.finditer(text))
    for index, match in enumerate(acceptance_criteria):
        criterion_id = match.group(1)
        end = acceptance_criteria[index + 1].start() if index + 1 < len(acceptance_criteria) else len(text)
        block = text[match.start() : end]
        for label in ("**Given**", "**When**", "**Then**"):
            if label not in block:
                errors.append(f"{criterion_id} missing: {label}")

    mermaid_count = len(MERMAID_PATTERN.findall(text))
    if mermaid_count and not re.search(r"^### (?:FLOW|SEQ|STATE|RULE)-\d{3}:", text, re.MULTILINE):
        errors.append("Mermaid content exists without a diagram heading and ID")
    if mermaid_count == 0:
        warnings.append("no Mermaid diagram found; confirm diagrams are not applicable")

    for term in VAGUE_TERMS:
        if term in text:
            warnings.append(f"review vague or unresolved wording: {term}")

    if "```json" in text or "```yaml" in text:
        errors.append("PRD content must use Markdown and Mermaid, not JSON or YAML blocks")

    if "checkCommand" in text or "evidenceType" in text:
        warnings.append("provider or execution evidence fields belong downstream, not in the PRD")

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
