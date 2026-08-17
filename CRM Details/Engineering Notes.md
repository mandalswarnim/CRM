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
