"""Tests for the AI-ready PRD validator."""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

VALIDATOR = Path(__file__).resolve().parents[1] / "scripts" / "validate_prd.py"

VALID_PRD = """# PRD: File upload

| Field | Value |
|---|---|
| Version | 1.0 |
| Status | Approved |
| Owner | Product |
| Last updated | 2026-10-28 |

## 1. Background & Problem

Users currently cannot upload files to a destination folder.

## 2. Goals & Success Measures

| Goal ID | Expected outcome | Success measure |
|---|---|---|
| GOAL-001 | Users can upload files | Successful upload is observable |

## 3. Users & User Stories

| User ID | User / role | User story | Value |
|---|---|---|---|
| USER-001 | File user | As a file user, I want to upload a file | So that I can store it |

## 4. Scope

| In scope | Out of scope |
|---|---|
| Upload a file | File editing |

## 5. Functional Requirements & Acceptance Criteria

| Requirement ID | Requirement | Priority | Acceptance criteria |
|---|---|---|---|
| FR-001 | Users can upload a valid file | Must | AC-001: Given a valid file, when the user uploads it, then the product confirms success |
"""


class ValidatePrdTests(unittest.TestCase):
    def run_validator(self, content: str) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "PRD.md"
            path.write_text(content, encoding="utf-8")
            return subprocess.run(
                ["python3", str(VALIDATOR), str(path)],
                check=False,
                capture_output=True,
                text=True,
            )

    def test_accepts_confirmed_concise_prd(self) -> None:
        result = self.run_validator(VALID_PRD)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_rejects_unresolved_placeholder(self) -> None:
        result = self.run_validator(VALID_PRD.replace("Users currently", "TBD: Users currently"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unresolved placeholder", result.stdout)

    def test_rejects_duplicate_requirement_id(self) -> None:
        duplicate = VALID_PRD.replace(
            "| FR-001 | Users can upload a valid file | Must | AC-001:",
            "| FR-001 | Users can upload a valid file | Must | AC-002:",
        ).replace("then the product confirms success", "then the product confirms success")
        duplicate = duplicate.replace(
            "| FR-001 | Users can upload a valid file | Must | AC-002: Given a valid file, when the user uploads it, then the product confirms success |",
            "| FR-001 | Users can upload a valid file | Must | AC-002: Given a valid file, when the user uploads it, then the product confirms success |\n| FR-001 | Users can upload a second valid file | Must | AC-003: Given a valid file, when the user uploads it, then the product confirms success |",
        )
        result = self.run_validator(duplicate)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("duplicate ID definition: FR-001", result.stdout)


if __name__ == "__main__":
    unittest.main()
