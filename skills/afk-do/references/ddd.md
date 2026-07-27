# DDD Implementation Guide

**Purpose**: Apply DDD patterns during implementation — when the feature involves bounded contexts from `docs/ddd/`.
**Tech stack**: Language-agnostic. Examples are illustrative; concepts apply to any language.
**When**: afk-implement Step 3, if the issue operates within bounded contexts from `docs/ddd/`.

---

## What is DDD?

**Domain-Driven Design** organizes code around **business concepts** rather than technical components.

The core question: **where does the same word mean the same thing?**

If "Order" means different things in billing and in shipping, those are different bounded contexts. Keeping them separate lets each team use familiar language without translation.

---

## Domain vs Bounded Context

A **Domain** is the whole business capability. A **Bounded Context** is a sub-domain with explicit boundaries where the same term has the same meaning.

```
Domain: E-commerce
├── Order Management Context  ← "Order" means one thing here
├── Catalog Context           ← "Product" means one thing here
├── Shipping Context         ← "Shipment" means one thing here
└── Billing Context          ← "Invoice" means one thing here
```

**One Domain, multiple Bounded Contexts.** Contexts do NOT share internal entities. Cross-context communication happens via domain events or explicit interfaces.

---

## Bounded Context — How to Draw the Boundary

The boundary is drawn where **the same term starts to mean different things**.

### Signals that two concepts are in DIFFERENT contexts

| Signal | Example |
|--------|---------|
| Same term, different meaning | Catalog "Product" = items with pricing. Warehouse "Product" = physical inventory with stock count. |
| Same data, different consistency | Order "Customer" = eventually consistent. Billing "Customer" = must be strongly consistent with payment records. |
| Different team owns it | Catalog team manages Product. Warehouse team manages inventory. |

### Signals that two concepts are in the SAME context

1. Changes to one almost always require changes to the other
2. The same team manages both
3. Business invariants span both

---

## Ubiquitous Language — Human ↔ Agent Contract

Ubiquitous Language is not just for human-to-human communication.
It is the **contract between human and agent**.

### Three layers

| Layer | Who benefits | Example |
|-------|------------|---------|
| Human ↔ Human | Team communication | Stakeholder and developer agree "Order" = purchase record |
| Human ↔ Agent | Precise instruction | Human says "create an Order", agent knows which method, which parameters |
| Agent ↔ Code | Exact mapping | Code's `Order.Create()` matches the domain concept, not a technical operation |

### When language is ambiguous — agent must ask

```
Human: "create a user"
Agent: reads docs/ddd/contexts/auth.md
      → "User" in Auth context = identity with session tokens
      → NOT: customer account (that's a different context)
      → Agent asks: "which User do you mean? Auth.User (identity) or Order.User (account holder)?",
        or defers to human with a specific question.
```

### Ubiquitous Language in practice

A well-defined term in `docs/ddd/contexts/<name>.md` looks like:

```markdown
## Ubiquitous Language

| Term | Definition | NOT meaning |
|------|-----------|-----------|
| Order | Purchase record initiated by Customer. States: draft → submitted → paid → shipped → completed. | Support ticket (different context) |
| LineItem | Product + quantity within an Order. Cannot exist without Order. | Standalone product listing (Catalog context) |
```

An agent reading this knows:
- To create an Order: call `Order.Create(req)` with `customerId` and `lineItems[]`
- Not to instantiate `Order` directly
- Not to add `LineItem` after `Order` is in `paid` state
- Not to confuse `Order` with `SupportTicket`

---

## Core Concepts

### Aggregate

A cluster of entities and value objects that must stay consistent together. One entity is the **aggregate root** — the only entry point from outside the aggregate.

```
Order (aggregate root)
├── LineItem[] (entity, belongs to Order)
├── Money total (value object)
└── invariant: total = sum(lineItem amounts)
```

External code holds a reference to Order only. It never touches LineItem directly.

### Repository Interface

An abstraction over data storage. Defined **inside the bounded context** (in the domain layer), implemented **outside** (in the infrastructure layer).

```
Domain layer:
  interface OrderRepository { Find(id): Order, Save(order): void }

Infrastructure layer:
  MySQLOrderRepository implements OrderRepository
  RedisOrderRepository implements OrderRepository
```

### Domain Event

A record of something significant that happened. Published by the bounded context, consumed by other contexts.

```
OrderCreated { orderId, customerId, timestamp }
  → published by Order context
  → consumed by Shipping context (triggers fulfillment)
  → consumed by Billing context (triggers invoice)
```

---

## Two Module Organization Modes

This guide supports two module organizations. **Deep Module (vertical slicing) is the default.**

---

### Mode A — Deep Module + Vertical Slicing (DEFAULT)

**Organize by bounded context, not by technical layer.**

Each bounded context is a **separate package/module**. Everything for that context lives together: its entities, value objects, repository interfaces, domain events, and application services.

```
src/
├── domain/
│   ├── order/              # Order bounded context
│   │   ├── models/         # Entities, value objects
│   │   ├── repository.go   # Repository interface (defined here)
│   │   ├── service.go      # Domain logic (invariants only)
│   │   └── events/         # Domain events published from here
│   │
│   ├── catalog/            # Catalog bounded context
│   │   ├── models/
│   │   ├── repository.go
│   │   ├── service.go
│   │   └── events/
│   │
│   └── shipping/
│       ├── models/
│       ├── repository.go
│       ├── service.go
│       └── events/
│
├── app/                    # Application services (use case orchestration)
│   ├── order_app.go
│   └── shipping_app.go
│
└── infra/                  # External adapters (implement repository interfaces)
    ├── mysql/
    ├── redis/
    └── queue/
```

**Why Deep Module:**

| | Deep Module | Shallow Module |
|--|------------|--------------|
| Interface | Small (Repository + a few methods) | Large (many methods) |
| Internal logic | Rich business rules | Thin (mostly passthrough) |
| Change scope | Local to context | Spans multiple layers |
| Independent deploy | Yes | No |

### Mode B — Shallow Module / Layered (opt-in only)

**Use only when the feature is simple CRUD on one entity with no cross-context interactions.**

```
src/
├── handlers/      # HTTP entry points
├── services/      # Business logic (thin)
├── repositories/ # Data access
└── models/       # Data structures
```

**When to use Mode B:**
- Single entity, single table
- No business invariants beyond "field required"
- No cross-context events
- Team already uses layered, feature is minor

---

## Repository Interface Pattern

**Interface in domain, implementation in infrastructure.**

```
// ❌ WRONG: infrastructure detail leaks into domain
domain/order/order.go:
  type OrderRepository struct { db *sql.DB }  // sql.DB is infrastructure

// ✅ CORRECT: interface lives in domain
domain/order/repository.go:
  type OrderRepository interface {
      Find(id string) (*Order, error)
      Save(o *Order) error
  }

infra/mysql/order_repository.go:
  type mysqlOrderRepository struct { db *sql.DB }
  func (r *mysqlOrderRepository) Find(id string) (*Order, error) { ... }
```

Why: you can swap MySQL for PostgreSQL without touching domain logic.

---

## Domain Events Pattern

**Publish from domain, subscribe from other contexts.**

```
domain/order/events/order_events.go:
  type OrderCreated struct {
      OrderID    string
      CustomerID string
      Timestamp  time.Time
  }

domain/order/service.go:
  func (s *OrderService) Create(req CreateOrderRequest) (*Order, error) {
      order := NewOrder(req)
      err := s.repo.Save(order)
      s.eventBus.Publish(OrderCreated{OrderID: order.ID, ...})
      return order, nil
  }
```

Why: contexts stay decoupled. Order context doesn't know who consumes OrderCreated.

---

## Choosing Between Modes

| Situation | Mode |
|-----------|------|
| Feature spans multiple bounded contexts | Mode A (default) |
| New bounded context discovered | Mode A (default) |
| Simple CRUD on one table, no invariants | Mode B |
| Feature within existing layered codebase | Match existing structure |

---

## When DDD is NOT Needed

DDD adds structure overhead. Use it when:
- Business rules are complex or stateful
- Multiple bounded contexts exist
- Team uses shared language that needs to be encoded in code

Skip DDD when:
- Feature is simple data transformation (read → write)
- No business invariants beyond field validation
- No cross-context communication
