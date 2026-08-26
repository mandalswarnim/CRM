---
tags: [engineering, gotchas]
updated: 2026-08-17
---

# Engineering Notes

Conventions, and the traps that have already cost time. **Read the traps before writing an engine
that calls another engine.**

## Conventions

- TypeScript ESM throughout; **`.js` extensions on relative imports** (Node ESM requires it)
- Tests are vitest against ephemeral in-memory PGlite (`createEphemeralDb`)
- British English in user-facing copy; `en_GB`, `Europe/London`, GBP are the org defaults
- Errors are always `SfError` so the wire shape stays compatible
- New engines register against [[Architecture#The save order|DML hooks]] — never edit the pipeline

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
- **Undelete does not re-run rollups** — a restored child is recounted on its next save.
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
