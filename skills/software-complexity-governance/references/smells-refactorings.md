# Code Smells ↔ Refactoring Patterns Mapping

Smells are symptoms; refactorings improve structure without changing external
behavior. Map complexity hotspots to smells, then choose the smallest safe
refactoring. Keep tests green.

Sources: Fowler/Beck *Refactoring*, Kerievsky *Refactoring to Patterns*,
Mäntylä taxonomy, Industrial Logic smells-to-refactorings, Refactoring.Guru.

## Taxonomy

| Category | Focus | Typical smells |
|----------|-------|----------------|
| Bloaters | Grown too large | Long Method, Large Class, Long Parameter List, Data Clumps, Primitive Obsession |
| OO Abusers | Weak OO use | Switch / Repeated Switches, Temporary Field, Refused Bequest, Alternative Classes with Different Interfaces |
| Change Preventers | Wide change ripple | Divergent Change, Shotgun Surgery, Parallel Inheritance Hierarchies |
| Dispensables | Needless elements | Duplicated Code, Lazy Class, Data Class, Speculative Generality, Dead Code, Comments-as-deodorant |
| Couplers | Excess coupling | Feature Envy, Inappropriate Intimacy, Message Chains, Middle Man |

## Mapping (smell → refactorings → related metrics)

| Smell | Prefer refactorings | Related metrics |
|-------|---------------------|-----------------|
| Long Method | Extract Method → Extract Class / Decompose Conditional / Replace Method with Method Object | High LOC, CC, Cognitive, Nesting |
| Large Class | Extract Class → Move Method / Extract Interface | High WMC, CBO, LOC |
| Duplicated Code | Extract Method → Pull Up / Form Template Method / Extract Superclass | Duplication density, Halstead volume |
| Feature Envy | Move Method → Extract Method | High fan-out / CBO |
| Long Parameter List | Introduce Parameter Object → Preserve Whole Object | Param count |
| Switch / Conditional Complexity | Replace Conditional with Polymorphism → State / Strategy / Null Object | High CC, Cognitive |
| Data Clumps | Extract Class / Introduce Parameter Object | — |
| Primitive Obsession | Replace Primitive with Object / Type Code with Class | — |
| Message Chains | Hide Delegate → Extract Method | Coupling depth |
| Middle Man | Remove Middle Man / Inline Method | — |
| Inappropriate Intimacy | Move Method/Field → Unidirectional association / Extract Class | High CBO |
| Shotgun Surgery | Move Method/Field → Extract Class | Change fan-out |
| Divergent Change | Extract Class → Move Method | Low cohesion (LCOM) |
| Temporary Field | Extract Class / Null Object / Method Object | — |
| Refused Bequest | Inheritance → Delegation / Push Down | — |
| Lazy Class | Inline Class / Collapse Hierarchy | — |
| Data Class | Encapsulate Field → Move Method closer to data | — |
| Speculative Generality | Collapse Hierarchy / Remove dead abstraction | — |
| Mysterious Name | Rename | — |
| Global / Mutable Data | Encapsulate / Replace Global with Parameter | Coupling via globals |

## Pattern-oriented (Kerievsky)

Conditional complexity → Strategy / State / Decorator.
Hierarchy duplication → Template Method / Composite.
Creation complexity → Creation Methods / Factory Method.
Null / special case → Null Object.

## Heuristics with complexity tools

- High CC + high Cognitive → Long Method or Conditional Complexity first.
- High CBO / envy → Move Method or Extract Class.
- High duplication → Extract Method / Pull Up.
- Large class with many medium-CC methods → Extract Class over endless Extract Method.

Re-measure after changes; prioritize by churn × complexity when possible.
