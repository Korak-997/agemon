---
name: agemon-performance
description: Use when writing or reviewing any code that runs more than once — loops, queries, API handlers, data pipelines, rendering paths — to keep the least-cost implementation the default rather than an afterthought. Covers algorithmic complexity, N+1 queries, hot-loop discipline, and when NOT to optimize. Complements web-design-guidelines/react-best-practices for front-end-specific performance rules.
---

# Performance by Default

Every implementation choice has a cost. This skill is about making cost a first-class input to the
implementation decision — not a separate "performance pass" done later, and not premature optimization done
speculatively. Pick the cheap-by-construction shape the first time; measure before reaching for anything more
clever.

## The Order of Operations

1. **Algorithmic complexity first.** A clean O(n log n) beats a hand-tuned O(n²). Before touching
   micro-optimizations, ask: does this scale with input size the way it should? Nested loops over the same
   collection, repeated linear searches where a map/set would do, and re-sorting on every call are the most
   common wastes here.
2. **Eliminate redundant work second.** Precompute values that don't change per-iteration, cache intermediate
   results within a request/operation, replace repeated lookups with a lookup table built once.
3. **Micro-optimize last, and only with a measurement in hand.** Don't reach for this tier speculatively —
   it's the one Simplicity First (see the code-quality group) explicitly warns against doing without a reason.

## The N+1 Check

The single highest-leverage pattern to catch: a loop that issues one query/request/call per item instead of
one call for all items.

```
# Costly — one round-trip per item
for order in orders:
    customer = db.get_customer(order.customer_id)

# Cheap — one round-trip total
customer_ids = {order.customer_id for order in orders}
customers = db.get_customers_by_ids(customer_ids)
```

This applies beyond databases: batch HTTP calls, batch file reads, batch subprocess invocations — anywhere a
loop body does I/O, ask whether the I/O can move outside the loop.

## Hot-Loop Discipline

Inside any loop that runs per-item over a large or unbounded collection:

- Don't allocate, parse, compile a regex, or open a connection per iteration — hoist it above the loop.
- Don't recompute a value that's constant across iterations.
- Prefer streaming/pagination over loading an entire dataset into memory when the dataset size isn't bounded
  by the caller.
- Batch writes (bulk insert, buffered output) instead of one write per item.

## When NOT to Optimize

- Code that runs once, or rarely, on small inputs (startup, CLI one-shots, admin scripts) — clarity wins over
  cleverness there. This mirrors Simplicity First: no defensive performance work for a cost that doesn't
  exist.
- Don't restructure working code around a hypothetical scale the project doesn't have and isn't asking for.
- If a real performance concern exists but fixing it is outside the current task's scope, name it rather than
  fixing it inline or going silent — the same scope discipline as any other out-of-scope finding.

## Where to Go for More

This skill covers general algorithmic and I/O discipline. For domain-specific detail:

- Front-end rendering, bundle size, re-renders, Core Web Vitals → `web-design-guidelines` /
  `react-best-practices` (Vercel Labs), if installed.
- Database indexing and query planning → the project's own database/ORM documentation; this skill only covers
  the *shape* of the calling code (batch vs. per-item), not index design.

## Quick Self-Check Before Shipping

- Does any loop body make a network/DB/filesystem call per iteration? → batch it.
- Does any loop recompute something constant across iterations? → hoist it.
- Is the algorithm's complexity class appropriate for realistic input sizes? → fix the algorithm before
  tuning constants.
- Is this optimization solving a real, measured cost, or a hypothetical one? → if hypothetical, don't.
