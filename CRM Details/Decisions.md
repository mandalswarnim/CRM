---
tags: [decisions, adr]
updated: 2026-08-26
---

# Decisions

Settled questions and the reasoning behind them. **Reopening one of these is fine — doing it by
accident is not.**

## Product scope

| Question | Decision | Why it matters |
|---|---|---|
| Platform or club app? | **Platform.** Build the generic engine; the club is a seed org on top. | Much larger build, but the rulebook is still arriving — rules must be config, not code. |
| Who logs in? | **Both.** Staff console and member portal, two shells over one API. | Sharing model has to be right; a member must see only their own records. |
| Which bookings? | **All three** — bedrooms, restaurant tables, private venues — differentiated per portal. | Drives [[Roadmap#15 Booking and inventory engine\|#15]], the hardest remaining problem. |
| Billing? | **Out of scope for now.** Track charges; no billing engine. | Keeps Phase C finite. Invoice/Payment exist as stubs only. |
| Tier-based access? | **No.** All members have the same access; categories differ on price. | Simplifies the security model enormously — no per-tier entitlement matrix. |
| Non-members? | **Guests of members**, and **reciprocal club members** (80+ clubs, 25+ countries). | Two distinct shapes: guests are hosted, reciprocals are verified. |

## Architectural rules

These are load-bearing. Breaking one is a rewrite, not a refactor.

### Every tenant statement goes through `withTenantClient`
It pins `search_path` to the org schema. There are **no cross-tenant queries, ever**. The tenant is
decided once per request from the session token — never from a header, path segment or anything else
the caller can assert.

### `LimitContext` threads through every engine call
Defined before anything consumed it, deliberately. Retrofitting a counter into thousands of
signatures later is a rewrite; adding a parameter now costs nothing.

### Security is a rewrite pass in the SOQL compiler
Sharing predicates are injected into the AST *before* SQL generation. FLS rejects unreadable fields
at compile time with `INVALID_FIELD`. Both were built as an injectable interface with an allow-all
default, and proven with tests, *before* the real policy existed — so switching it on was a swap,
not a rewrite.

**Consequence worth knowing**: an unreadable field cannot be probed by filtering on it, because the
filter path checks FLS too.

### Describe is the single source of truth
For both the API response and the UI. See [[What We Are Building#2 Describe is the single source of truth]].

### Errors use `SfError`
So the wire shape stays Salesforce-compatible everywhere, including inside composite sub-requests.

## Engine-level calls

### Rollups are recomputed, not incremented
A drifting counter is far worse than a recount, and the recompute is one indexed aggregate per
parent batch. Both sides of a reparent are recalculated.

### Sharing rules are materialised into `record_share`
Rather than interpreted per query. The query path then does one indexed lookup instead of evaluating
every rule for every row.

### Record locking is derived, not stored
A `locked` flag plus the work items describing why would be two sources of truth, and they would
drift — a crashed process would leave records locked forever with nothing to unlock them. Derived
from pending approval work items, a record is locked exactly while something is pending.

### Workflow fires once per save
Salesforce re-evaluates rules once more after a field update. Meridian guards against re-entry
entirely, making loops impossible. A self-triggering rule terminates rather than spinning. If
cascading workflow is ever needed, the guard becomes a depth counter.

### Read failures hide; write failures explain
A record you cannot read returns null or zero rows — indistinguishable from absent. A write you
cannot perform says so plainly. Same for fields: unreadable is `INVALID_FIELD`, uneditable is
`INVALID_FIELD_FOR_INSERT_UPDATE`.

### Email defaults to files on disk
`.eml` under `DATA_DIR/outbox`. The platform works offline, and nothing accidentally reaches a real
member's address in development. SMTP is opt-in via `EMAIL_TRANSPORT`.

### The weekly export is a full dump, not a delta
It is the "get my data out" guarantee. A delta that silently misses rows is worse than no export.

### Advisory locking is skipped on the embedded driver
It coordinates *replicas*. PGlite is one connection in one process — nothing to coordinate, and
holding the lock would starve the work itself. See [[Engineering Notes#The nested-connection trap]].

---

## Booking is a generic engine configured by metadata

**Decided in [[Roadmap#15 Booking and inventory engine|#15]].** The parked question was "first-class
engine, or a specialised object type within the metadata engine?" The answer is *both halves of what
each option was protecting*: a **generic allocation engine** whose configuration is ordinary
metadata.

`server/src/inventory/` owns real tables and real constraints, because correct availability needs
them and JSONB cannot carry an exclusion constraint. But it knows nothing about the club — a
resource is "a thing that can be booked", and `Booking__c` is an ordinary metadata object that
declares which of its fields mean resource, start and end. The club stays data.

**Why not the object-type route**: records live in JSONB, so a constraint needs real typed columns,
which means the installer would generate a side-table per bookable object anyway — the same design
with N constraints to maintain instead of one.

**What it cost**: the textbook constraint needs `btree_gist`, which PGlite lacks, so the resource is
folded into the range. See [[Engineering Notes#Folding the resource into the range]].

---

Related: [[Architecture]] · [[Engineering Notes]] · [[Open Questions]]
