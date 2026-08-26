---
tags: [engineering, gotchas]
updated: 2026-08-26
---

# Engineering Notes

Conventions, and the traps that have already cost time. **Read the traps before writing an engine
that calls another engine.**

## Conventions

- TypeScript ESM throughout; **`.js` extensions on relative imports** (Node ESM requires it)
- Tests are vitest against ephemeral in-memory PGlite (`createEphemeralDb`)
- British English in user-facing copy; `en_GB`, `Europe/London`, GBP are the org defaults
- Errors are always `SfError` so the wire shape stays compatible
- New engines register against [[Architecture#The save order|DML hooks]] — never edit the pipeline.
  The one licence: adding a *missing stage call* so a path fires hooks at all, as
  [[Roadmap#15 Booking and inventory engine|#15]] did for undelete. Engine logic still stays out.

## Commands

```bash
npm install     # needs --cache <dir> under a sandbox that blocks ~/.npm
npm test        # vitest, server workspace
npm run seed    # provision an org into embedded PGlite
npm run dev     # server :4000 (no client until #19)
npx tsc -p server/tsconfig.json --noEmit
```

---

## The nested-connection trap

> [!danger] This has caused two hangs. It presents as a **timeout, not an error**.

PGlite is a **single connection** behind a mutex. Any code path that holds a connection and then
asks for a second one deadlocks. It does not throw — it hangs, and the test suite sits there until
the timeout fires.

**Occurrence 1 — [[Roadmap#12 Approval processes|#12]].** `submitForApproval` opened a transaction,
then called `updateRecords`, which called `ensureUserAccess`, which asked for another connection.

*Fix*: `RequestContext.tenant()` is now **re-entrant** — nested calls reuse the client the outer
call already holds.

*Why it mattered beyond PGlite*: on pooled Postgres the same code would have **silently** split one
logical transaction across two connections, so a rollback would undo only half the work. The hang
was the lucky outcome.

**Occurrence 2 — [[Roadmap#13 Scheduler|#13]].** `withAdvisoryLock` held the connection while the
work it guarded needed one.

*Fix*: skip advisory locking on the embedded driver. It coordinates replicas; there is one process,
so there is nothing to coordinate.

**The rule**: if you hold a connection, everything inside must use *that* client. Pass it down.

---

## Folding the resource into the range

> [!danger] PGlite has no `btree_gist`. The textbook booking constraint cannot be built on it.

The standard way to stop double-booking is

```sql
EXCLUDE USING gist (resource_id WITH =, span WITH &&)
```

but the `=` operator on a text column needs **`btree_gist`**, and the embedded driver does not have
it — `extension "btree_gist" is not available`. Since every test runs against PGlite, taking that
route would have left *the one guarantee this engine exists to provide* untested.

So the resource is folded into the range instead. Each resource owns a private band of the number
line, `ordinal × STRIDE`, and the span is offset into it:

```
room 7, 1–5 Sep → [7×STRIDE + 2119680, 7×STRIDE + 2125440)
room 8, 1–5 Sep → [8×STRIDE + 2119680, 8×STRIDE + 2125440)
                   ↳ same dates, and they still cannot overlap
```

A plain `EXCLUDE USING gist (span WITH &&)` — no extension — then *means* "no double booking", and
behaves identically on both drivers. `STRIDE` is 4×10⁹ minutes (~7,600 years), which bounds the
supported dates; anything before 1970 or beyond that is refused rather than silently wrapped into a
neighbour's band.

**Two mechanisms, both enforced by the database**, because "one room" and "sixty covers" are
genuinely different problems:

- `exclusive` → the range exclusion constraint above
- `pool` → `inventory_usage`, one counter row per grain step, with `CHECK (taken <= ceiling)`

Neither is a read-then-write, so neither can lose a race. Two tests fire concurrent reservations at
the last slot and assert exactly one wins.

### Allocation runs in `validate`, not `sideEffects`
Losing the race for the last room must **abort the save**, exactly as a validation rule does. A
booking record that exists without capacity behind it is precisely the bug the engine is for.
Delete and undelete never reach `validate` (see below), so they are handled in `afterSave`.

### Expired holds are released on the reserve path
Not left to the sweeper. Correctness must not depend on how recently a scheduled job ran — an
expired hold keeping a room off sale is a lost booking. `expireHolds` is housekeeping so
*availability* stays honest between reservations, not the mechanism.

---

## Search reuses the query path on purpose

> [!important] The index knows nothing about sharing. It must never be the thing that decides what
> a user sees.

[[Roadmap#14 SOSL and global search|#14]] runs in two stages:

1. `search_index` answers **which records match** the term.
2. Each object is then re-queried through the **ordinary SOQL compiler**, with the matched ids
   ANDed into the caller's own `WHERE`.

So sharing rewrites and FLS apply to search exactly as they apply to a query, because it *is* a
query — `runQueryAst()` was added to `soql/execute.ts` so SOSL could hand over a prepared AST
instead of rebuilding a query as text. Nothing about security is reimplemented in `sosl/`.

The cost is that rows the user cannot see drop out at stage 2, so the index scan deliberately
reaches past the caller's `LIMIT` (`SCAN_CAP`, 2000) and the result is trimmed afterwards.

### Search terms never become SQL
The `FIND {…}` expression is parsed to a tree, then compiled to a `tsquery` **string** that is
passed to `to_tsquery('simple', $n)` as a bind parameter. Every lexeme is single-quoted with
tsquery's own operators stripped, so `x';DROP TABLE search_index;--` is three harmless words.

### Weights are how search groups work
One `tsvector` per record, with the weight recording *what kind of field* a word came from:
**A** name · **B** general text · **C** email · **D** phone. `IN NAME FIELDS` is then a
`ts_rank` mask (`{0,0,0,1}`) rather than a second index. Two things this forced:

- **Postgres tokenises `enquiries@bengalclub.in` as one lexeme**, so the domain and local part are
  indexed alongside the whole address or searching for either would miss.
- **Phone numbers are indexed as written *and* as bare digits**, so `020 7290 1400` and
  `02072901400` find each other.

Changing what gets indexed leaves already-written rows stale. `reindexSearch` (a scheduled job
kind) rebuilds from the records themselves; it is the migration path for exactly this.

---

## Other lessons

### Security defaults must fail closed
When the SOQL executor did not resolve user access, the policy denied everything and 13 tests failed
loudly. That is the correct direction — a bug that denies is recoverable; a bug that grants is a
breach.

### The after-image needs `Id` on insert
Hooks read `change.after` as a complete record. Without `Id`, anything derived from it — task links,
queue rows, formulas referencing Id — came out **null and silent**. Fixed in the pipeline.

### `relationshipName` is the *child* side
`Contact.AccountId.relationshipName` is `'Contacts'` — the name Account uses for its children, not
the parent traversal name. Parent names derive from the API name: `AccountId` → `Account`,
`Member__c` → `Member__r`.

### Child subqueries need the foreign key
Batching groups children by their FK, but `SELECT Id, LastName FROM Contacts` does not return
`AccountId`. The FK is added to the child query and stripped from the output afterwards.

### `undeleteRecords` fired no hooks at all
Not a missing case — the stage calls were simply absent, so every engine missed restores: rollups
went stale, the search index never re-added the record, and a restored booking would have had no
room behind it. Adding `afterSave` and `sideEffects` to that path fixed all four at once, and no
existing test changed behaviour except the rollup one that had been documenting the gap.

### `historyEnabled` defaults to true
So the real gate is whether any field is actually tracked. Without that check, every insert on every
object wrote a history row for nothing.

### Unknown fields are rejected, not dropped
With JSONB storage, a typo would otherwise land silently in the body and be invisible until someone
noticed missing data.

---

## Known gaps, deliberate

Recorded so they are not mistaken for oversights:

- **Formula fields** can be selected but not filtered, sorted or grouped on — nothing is stored.
  Raises `MALFORMED_QUERY` rather than returning wrong rows. *(Rollups are stored, so they are
  queryable.)*
- ~~Undelete does not re-run rollups~~ — **fixed in [[Roadmap#15 Booking and inventory engine|#15]]**: `undeleteRecords` now fires `afterSave` and `sideEffects`, so rollups, history, feed and the search index all see a restore. It fired no hooks at all before, which the booking engine could not live with.
- **Polymorphic traversal** needs `TYPEOF`; unimplemented, raises a clear error.
- **Duplicate external IDs within one batch** are caught by the unique index rather than the
  pre-check, so the whole batch fails instead of the one record. Data stays correct.
- **Workflow fires once per save** — see [[Decisions#Workflow fires once per save]].
- **Search does not apply FLS to the *index body*.** Results are re-queried through SOQL, so
  sharing and field-level reads are enforced on what comes back — but a user who can already see a
  record could infer that a term appears *somewhere* on it, including in a field they may not read.
  Narrow, and recorded rather than assumed away; closing it means indexing per field.
- **Leading and infix wildcards are rejected**, not silently dropped: `*club` and `ori*ental` raise
  `MALFORMED_SEARCH`, because a GIN index cannot answer them and a slow sequential scan pretending
  otherwise is worse than a clear error.
- **`?` single-character wildcards** are unsupported and raise rather than being ignored.
- **Screen flows** are interpreted headlessly; there is no UI to pause against until
  [[Roadmap#19 Client foundation|#19]].
- **`npm run dev`** starts no client until #19.

---

## Testing approach

Fixtures use **real club rules**, not toy data — `GuestVisit__c` with a six-guest limit, membership
applications routed to the Membership Secretary then the Sub-Committee. This doubles as proof the
platform can express the domain without domain code.

Tests that need enforcement call `installSecurity()` / `installAutomation()` themselves; the
permissive default policy is what runs otherwise.

---

Related: [[Architecture]] · [[Decisions]] · [[Session Log]]
