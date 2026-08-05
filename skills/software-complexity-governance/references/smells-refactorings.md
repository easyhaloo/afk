# Code Smells ↔ Refactoring Patterns Mapping

Code smells are symptoms of deeper design problems; refactorings are the prescribed remedies that improve internal structure without changing external behavior. This mapping links classic smells (Fowler/Beck + extensions) to recommended refactorings and related complexity metrics, so that complexity detection can directly drive actionable refactoring.

Sources: Martin Fowler & Kent Beck *Refactoring* (1st/2nd ed.), Joshua Kerievsky *Refactoring to Patterns*, Mäntylä taxonomy, Industrial Logic “Smells to Refactorings” quick reference, Refactoring.Guru.

## Taxonomy Overview

| Category | Focus | Typical Smells |
|----------|-------|----------------|
| **Bloaters** | Code that has grown too large | Long Method, Large Class, Long Parameter List, Data Clumps, Primitive Obsession |
| **Object-Orientation Abusers** | Incomplete / incorrect use of OO | Switch / Repeated Switches, Temporary Field, Refused Bequest, Alternative Classes with Different Interfaces |
| **Change Preventers** | Changes ripple widely | Divergent Change, Shotgun Surgery, Parallel Inheritance Hierarchies |
| **Dispensables** | Unnecessary or dead elements | Duplicated Code, Lazy Class/Element, Data Class, Speculative Generality, Dead Code, Comments (as deodorant) |
| **Couplers** | Excessive coupling or delegation | Feature Envy, Inappropriate Intimacy / Insider Trading, Message Chains, Middle Man |

## Detailed Mapping Table

| Code Smell | Typical Symptoms & Complexity Link | Recommended Refactorings (priority order) | Related Complexity Metrics |
|------------|------------------------------------|-------------------------------------------|----------------------------|
| **Long Method / Long Function** | Method does too much; high nesting or many decisions | Extract Method → Extract Class / Replace Temp with Query / Decompose Conditional / Replace Method with Method Object | High LOC/NLOC, high Cyclomatic, high Cognitive Complexity, high Nesting Depth |
| **Large Class / God Class** | Too many fields/methods; mixed responsibilities | Extract Class → Extract Subclass / Move Method / Extract Interface | High WMC, high CBO, high aggregated CC, high LOC |
| **Duplicated Code** | Identical or near-identical fragments | Extract Method → Pull Up Method / Form Template Method / Extract Superclass / Extract Class | High duplication density; elevated Halstead Volume |
| **Feature Envy** | Method uses more data/behavior of another class than its own | Move Method → Extract Method | High Fan-out / CBO |
| **Long Parameter List** | Too many parameters | Introduce Parameter Object → Preserve Whole Object / Replace Parameter with Method Call | Parameter count > 4–7 |
| **Switch Statements / Repeated Switches / Conditional Complexity** | Large switch or deeply nested if-else | Replace Conditional with Polymorphism → Replace Type Code with Subclasses / State / Strategy / Introduce Null Object | High Cyclomatic, high Cognitive Complexity |
| **Data Clumps** | Same groups of data appear together repeatedly | Extract Class / Introduce Parameter Object | — |
| **Primitive Obsession** | Primitives used for domain concepts | Replace Primitive with Object / Replace Type Code with Class / Introduce Parameter Object | — |
| **Message Chains** | a.getB().getC().doX() | Hide Delegate → Extract Method | High coupling depth |
| **Middle Man** | Class mostly delegates | Remove Middle Man / Inline Method | — |
| **Inappropriate Intimacy / Insider Trading** | Classes know too much about each other’s internals | Move Method / Move Field → Change Bidirectional Association to Unidirectional / Extract Class / Hide Delegate | High CBO, bidirectional coupling |
| **Shotgun Surgery** | One change requires edits in many places | Move Method / Move Field → Extract Class | High change fan-out |
| **Divergent Change** | One class changed for many different reasons | Extract Class → Move Method | Low cohesion (high LCOM) |
| **Parallel Inheritance Hierarchies** | Adding a subclass forces adding another elsewhere | Move Method / Move Field → Collapse Hierarchy | — |
| **Temporary Field** | Field only used in certain circumstances | Extract Class / Introduce Null Object / Replace Method with Method Object | — |
| **Refused Bequest** | Subclass does not use / does not want inherited members | Replace Inheritance with Delegation / Push Down Method / Push Down Field | — |
| **Alternative Classes with Different Interfaces** | Similar classes with different method names | Rename Method → Extract Interface / Unify Interfaces with Adapter / Move Method | — |
| **Lazy Class / Lazy Element** | Class does too little | Inline Class / Collapse Hierarchy | Low complexity but still maintenance cost |
| **Data Class** | Class only holds data, little behavior | Encapsulate Field → Move Method / Extract Class (move behavior closer) | — |
| **Speculative Generality** | Over-generalization for anticipated future needs | Collapse Hierarchy / Inline Class / Remove Parameter / Remove Dead Code | — |
| **Dead Code** | Unused code | Remove Dead Code | — |
| **Comments (as deodorant)** | Comments used to explain bad code | Rename Method / Extract Method / Introduce Assertion (make code self-explanatory) | — |
| **Mysterious Name** | Unclear names | Rename Method / Rename Variable / Rename Class | — |
| **Global Data / Mutable Data** | Shared mutable state | Encapsulate Variable / Replace Global with Parameter / Introduce Parameter Object | High coupling via globals |

## Pattern-Oriented Extensions (Kerievsky)

| Smell / Situation | Pattern-directed Refactoring |
|-------------------|------------------------------|
| Conditional Complexity | Replace Conditional Logic with Strategy / State / Decorator |
| Duplicated Code across hierarchy | Form Template Method / Extract Composite |
| Creation complexity | Replace Constructors with Creation Methods / Introduce Polymorphic Creation with Factory Method / Encapsulate Classes with Factory |
| Null checks / special cases | Introduce Null Object |
| Combinatorial Explosion | Replace Implicit Language with Interpreter |

## Usage with Complexity Governance

1. Run complexity tools (lizard, radon, complexipy, SonarQube) → surface high-CC / high-Cognitive / high-LOC / high-CBO items.
2. Map the hotspots to the smells above.
3. Choose the corresponding refactoring(s); prefer small, test-protected steps.
4. Re-measure: expect drop in Cyclomatic / Cognitive / Nesting / coupling metrics.
5. Record remaining debt and prioritize by change frequency × complexity (hotspot score).

## Quick Heuristics

- High Cyclomatic + high Cognitive → look first at Long Method or Conditional Complexity.
- High CBO / Feature Envy signals → Move Method or Extract Class.
- High duplication → Extract Method / Pull Up.
- Large Class + many methods with medium CC → Extract Class rather than many Extract Methods.

Always keep tests green and prefer the simplest refactoring that removes the smell.
