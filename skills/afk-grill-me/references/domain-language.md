# Ubiquitous Language Collection

**Purpose**: Capture and reconcile domain terminology during grill-me sessions.
**When**: During and after stakeholder interviews, before writing CONTEXT.md.
**Output**: Sections in `CONTEXT.md` — `## Ubiquitous Language` + project `docs/ddd/language/glossary.md`.

---

## Core Principle

**The same term must mean the same thing within one bounded context.**

If a term means different things in different contexts, it belongs in the **cross-context glossary with explicit conflict notes**, not in a single definition.

---

## Collection Process

### Step 1 — List All Terms

As you interview, maintain a running list:

```
Term          | Context   | Definition
--------------|-----------|-------------------------------
Product       | Catalog   | Item listed for sale with price and SKU
Product       | Inventory | Physical item with stock count and location
Customer      | Order     | Account holder who places orders
Customer      | Auth      | Identity with credentials for login
```

### Step 2 — Flag Conflicts

If the same term appears in multiple contexts with different definitions, mark it as **conflict**.

### Step 3 — Reconcile or Separate

- **Same meaning everywhere** → one definition, used everywhere
- **Different meanings** → keep separate, note which context owns which definition

---

## Glossary Format (for `docs/ddd/language/glossary.md`)

```markdown
# Ubiquitous Language — <Project/Domain Name>

## Cross-Context Terms

| Term | Order | Catalog | Inventory | Auth |
|------|-------|---------|-----------|------|
| Customer | Account holder who places orders | ❌ not used | ❌ not used | Identity with credentials |
| Product | Line item with price | Item with SKU and description | Physical item with stock | ❌ not used |

## Conflict Terms

| Term | Context A | Context B | Resolution |
|------|-----------|-----------|------------|
| (none yet) | | | |
```

---

## Ubiquitous Language — Human ↔ Agent Contract

A well-defined term enables the agent to act without asking for clarification:

| When human says | Agent should understand | Agent should NOT assume |
|---------------|---------------------|----------------------|
| "create a Customer" | Which context? Ask: Order.Customer or Auth.Identity? | Any meaning |
| "update the price" | Which context? Ask: Catalog.Product or Inventory.Item? | Any meaning |
| "get the status" | Which context? Ask: Order.Order or Shipment.Shipment? | Any meaning |

**Rule**: if a term is ambiguous across contexts, the agent must ask before acting.

---

## Common Pitfalls

- **Synonyms**: "document" vs "record" vs "entry" — pick one, discard others within each context
- **Inheritance**: don't use generic terms ("entity", "object") — use specific domain terms
- **Acronyms**: always expand on first use

---

## Update Contract

When a new bounded context is discovered during grill-me:
1. Add entries to the cross-context table
2. Flag any new conflict terms
3. Write the resolution in the Conflict Terms section

This glossary is the **project SSOT for domain terminology**. All subsequent phases reference it.
