# Bounded Context Discovery

**Purpose**: Guide agents to identify bounded contexts during stakeholder interviews.
**When**: Every grill-me session before writing CONTEXT.md.
**Output**: Sections in `CONTEXT.md` — `## Bounded Contexts` and `## Context Map`.

---

## What is a Bounded Context?

A semantic boundary within which each term has one unambiguous meaning.
Outside the boundary, the same term can mean something completely different.

**Example**: `Product`
- In **Catalog** context: item with name, description, price, SKU
- In **Inventory** context: item with stock count, warehouse location, reorder point
- Same term, different meaning, different consistency requirements

---

## Discovery Process

### Step 1 — Collect Domain Terms

During interview, write down every technical term the stakeholder uses.
Group them as you go. Ask: "What do you mean by X?"

### Step 2 — Detect Conflicts

For each term, ask:
- "Does this mean the same thing in every part of the system?"
- "Who owns this data / this decision?"
- "What must be true together?"

**Same term, different meanings** → found a context boundary.

### Step 3 — Classify Subdomain Type

For each bounded context, ask: **"Is this where our competitive advantage lives?"**

| Type | Definition | Investment |
|------|-----------|-----------|
| **Core Domain** | Differentiating capability — why customers choose this over alternatives | Most investment, build in-house |
| **Supporting Domain** | Necessary but not differentiating — we build because we must | Build to spec, no more |
| **Generic Domain** | Universally needed — auth, email, logging | Buy or use open source |

### Step 4 — Draw Context Map

```
[Context A] --[events/data]--> [Context B]
     |                              |
     | upstream                     | upstream
     v                              v
[External System]            [Another Context]
```

### Step 5 — Name the Aggregate(s)

Within each context: what must stay consistent together?
Group fields/entities that change together → aggregate root.

---

## Red Flags (context boundary needed)

| Signal | Example |
|--------|---------|
| Same noun, different verbs | "user: creates account" vs "user: deactivates account" |
| Same field, different rules | "status: can be null in Order, never null in Invoice" |
| Different team owns it | "Billing team manages pricing, Product team manages products" |
| Different consistency requirement | "order: must be consistent within a transaction" vs "order: can be eventually consistent" |

---

## Output Sections for CONTEXT.md

```markdown
## Bounded Contexts

| Context | Owner | Subdomain | Key Terms | Boundary Rationale |
|---------|-------|-----------|-----------|---------------------|
| order | order-team | Core | Order, LineItem, Pricing | Purchase record — differentiating capability |
| catalog | catalog-team | Core | Product, Category, SKU | Product listing — differentiating capability |
| inventory | warehouse-team | Supporting | Stock, Warehouse, ReorderPoint | Physical inventory tracking |
| notification | platform-team | Generic | Template, Channel, DeliveryLog | Email/SMS — generic capability |

*(Subdomain: Core = differentiating; Supporting = necessary but not differentiating; Generic = buy/use open source)*

## Context Map

[Order] --ORDER_CREATED--> [Inventory] --low-stock-trigger--> [Notification]
```

---

## Bounded Context vs Data Model

| | Bounded Context | Data Model |
|--|---|---|
| Unit | Semantic boundary (team, language, ownership) | Technical boundary (table, schema) |
| Criteria | Same term means same thing within the boundary | Same entity, same table |
| Scope | Business language | Technical schema |
| Change rate | Slow (team structure) | Fast (feature requirements) |

**Correct approach:** discover bounded contexts by finding semantic boundaries in the team's language. Then map data models to contexts — one context can have many data models.

❌ **Wrong:** "auth has a users table, billing has a users table → two bounded contexts"
✅ **Correct:** "auth.users and billing.users are different data models within the same billing context if 'user' means the same thing in both."

❌ **Wrong:** "every entity has its own context → auth/User, billing/User, orders/Order"
✅ **Correct:** "User in billing context means account-holder with payment methods → one User aggregate"

**Note:** The table above replaces "when to use DDD" rules. If your domain is simple (one context, no semantic conflicts), DDD adds overhead — skip bounded context discovery and use a simple layered structure.
