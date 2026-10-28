# Business Rules and Status Mapping

Use when user-provided or repository-defined business rules include state machines, status codes, error codes, eligibility rules, or conditional outcomes.

## Establish traceability

For each rule, record a stable rule ID, source file/heading or API contract, preconditions, trigger, expected outcome, and any prohibited outcome. Keep confirmed rules separate from assumptions and observed legacy behavior.

Build a focused decision table for important combinations, such as role × current state × action × expected result. Include negative cases that prove a disallowed transition is rejected. Avoid generating the full Cartesian product unless every combination is meaningful.

## Keep status layers separate

Map each relevant concept independently:
- transport/protocol status (such as an HTTP response status);
- application error code and user-visible result;
- persisted business status or state transition;
- emitted event/callback and other side effects.

Test both the allowed transition and important rejected transitions. Verify state and side effects where a response alone cannot prove the rule.

## Report

Map each rule ID to the test case(s), test file, result, and uncovered conditions. If two sources disagree, report the conflict and do not invent the expected status.
