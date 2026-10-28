# Behavioral Design Patterns at the Code Level

This catalog is distinct from runtime interaction patterns such as async messaging. Use it when implementation or an explicit architecture uses a named design pattern. Test the promised behavior and collaboration contract, not the pattern name or internal class layout.

| Design pattern | What to verify |
|---|---|
| Strategy | Each strategy satisfies the shared contract; selection/configuration chooses the intended strategy; boundary inputs behave consistently. |
| Observer / Publish-Subscribe | Subscribers receive the specified notification; unsubscribe/lifecycle works; ordering and failure isolation are tested only when promised. |
| Command | Command validation, execution, queuing/delay, idempotency, and undo/compensation semantics where provided. |
| State | Allowed and rejected transitions, state-specific behavior, terminal state rules, and side effects. |
| Chain of Responsibility | Correct handler selection and order, propagation/termination behavior, and no accidental duplicate handling. |
| Mediator | Components coordinate through the declared mediator contract; important workflows work without relying on unrelated direct coupling. |
| Template Method | Required invariant steps always occur; custom steps can vary without breaking the base contract. |
| Iterator | Traversal order if guaranteed, empty collections, invalidation/concurrent modification, and no skipped/duplicated elements. |
| Memento | Save/restore preserves the promised observable state and does not expose or mutate protected internals. |
| Visitor | Each supported element/type is handled; new or unsupported types fail explicitly or follow the documented fallback. |
| Interpreter | Grammar boundaries, precedence, malformed expressions, and semantic results. |

Do not force an architectural pattern into a project merely because it appears in this table. If source code does not use the pattern, derive tests from behavior rather than adding tests for hypothetical design patterns.

## Source

- Refactoring.Guru, Behavioral Design Patterns: https://refactoring.guru/design-patterns/behavioral-patterns
