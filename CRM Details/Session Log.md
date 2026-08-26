---
tags: [log, history]
updated: 2026-08-26
---

# Session Log

What was built, and what each piece of work taught. Newest last.

---

## Before this vault existed

**Four commits** on `claude/salesforce-crm-clone-g05zeb` — the interpretive core, built bottom-up:
architecture doc and monorepo scaffold, database layer, formula engine, metadata engine.
~4,000 lines, 28 tests.

Nothing was runnable. `npm run dev`, `npm run seed` and `npm start` all referenced files that did not
exist; `express` was a dependency that nothing imported. The README described a finished product.

**Lesson recorded**: `docs/architecture.md` and `README.md` are *specifications written up front*.
Check the code before believing either.

---

## `4cdc402` — Roadmap, context, club domain

Interviewed on scope, read the club's public site, discovered the
[[What We Are Building#The strategic situation|Experience Cloud site]]. Wrote [[Roadmap]],
[[Club Domain]] and `CLAUDE.md`.

**Decisions taken**: platform not app · both portals · all three booking types · billing deferred ·
no tier-based access · guests + reciprocals. See [[Decisions]].

---

## `a66ef60` — The platform

Runtime spine, DML pipeline, SOQL engine, security model, REST API. Took the project from three
isolated engines to a working API server. **178 tests.**

**Milestone**: curl creates a record, queries it with SOQL, describes an object and runs an atomic
composite transaction.

**Bugs found and fixed:**
- `relationshipName` is the *child* side — see [[Engineering Notes#relationshipName is the child side]]
- Child subqueries returned null always (missing FK)
- Date-literal filters crashed on bind count
- `HAVING COUNT(Id) > 1` did not parse
- SOQL executor never resolved user access, so the policy failed **closed** — 13 tests failed loudly.
  Fixed with an optional `prepare(ctx)` on the policy interface rather than importing security into
  the query engine.

---

## `e276043` — DML side effects

Rollups, field history, feed items, search index, change bus. **196 tests.**

**Notable**: rollups became *stored*, which made them filterable and sortable — closing half of a
documented SOQL gap.

**Bugs**: rollups returned as JSON strings not numbers; history wrote a row per insert on **every**
object because `historyEnabled` defaults true.

---

## `3f209b0` — Validation and workflow rules

**The first real club rules became configuration.** Test fixtures encode the actual six-guest limit
and the members-must-accompany-guests-for-dining rule. **217 tests.**

**Bug**: the after-image of an insert carried no `Id`, so anything a hook derived from it came out
null and silent. See [[Engineering Notes#The after-image needs Id on insert]].

---

## `d80ea6f` — Flow engine

JSON DSL interpreter, nine element types, record-triggered before-save and after-save. **239 tests**,
all green first run.

**Notable**: `$Record__Prior` lets a flow detect a *transition* rather than a state — "just
cancelled" vs "still cancelled". Two runaway cases closed deliberately: element counting bounds
loops, a call stack catches subflow cycles and names the path.

---

## `27d6d9f` — Approval processes

Multi-step chains, four approver types, unanimity, derived record locking, recall, full history.
**258 tests.** Test fixtures are the club's real membership application chain.

**The first hang.** Not a failure — a *timeout*. See
[[Engineering Notes#The nested-connection trap]]. Fixed by making `RequestContext.tenant()`
re-entrant, which also closed a silent transaction-splitting bug that would have bitten on real
Postgres.

---

## `b456882` — Scheduler

Cron parser, advisory-locked multi-org tick, time-based triggers, scheduled flows, purge, weekly
export, email dispatch. **278 tests.**

**Closes the loop from #10** — the reminders workflow rules queue now actually fire.

**The second hang**, same shape: `withAdvisoryLock` held PGlite's only connection while the work it
guarded needed one. Fixed by skipping the lock on the embedded driver — it coordinates replicas, and
there is one process.

**Failure containment is most of what a scheduler is**: one bad trigger marks itself Failed and the
rest run; `next_run` is stamped *before* execution so a throwing job moves on; `nextRun` is bounded
to four years so an unsatisfiable expression returns null.

---

## SOSL and global search

`FIND {…}` with phrases, AND/OR/NOT and trailing wildcards; the four search groups; `RETURNING`
with per-object WHERE / ORDER BY / LIMIT; `/search`, `/parameterizedSearch`, `/search/suggestions`.
**317 tests.**

**No hang this time** — because the two traps above were already known. The nested-connection rule
shaped the design: candidate resolution and each re-query take their own client through
`ctx.tenant()`, which is re-entrant.

**The design decision that mattered**: search does not get its own security. It resolves ids from
the index, then goes back through the SOQL compiler, so sharing and FLS are inherited rather than
re-implemented. `runQueryAst()` was added so SOSL could pass a prepared AST rather than build query
text. See [[Engineering Notes#Search reuses the query path on purpose]].

**Two things Postgres decided for us.** An email address is a *single* lexeme, so `bengalclub.in`
did not match `enquiries@bengalclub.in` until the parts were indexed too — caught by a test written
before the behaviour was known. And phone numbers needed a bare-digits form, or `02072901400` would
never find `020 7290 1400`.

Changing the index format made `reindexSearch` necessary: a scheduled job that rebuilds from the
records, so a change to what is indexed reaches rows nobody has touched since.

---

## Booking and inventory engine

The hard one. Resources, allocations, holds with expiry, overbooking policy, opening hours as
booking windows, availability, a REST surface. **354 tests.**

**The decision, taken before code**: a generic allocation engine configured by metadata — see
[[Decisions#Booking is a generic engine configured by metadata]]. Real tables and real constraints,
because availability needs them; no knowledge of the club, because the club is data.

**The finding that changed the design.** The plan of record — in `CLAUDE.md` and the roadmap — was
`EXCLUDE (resource_id WITH =, span WITH &&)`. That needs `btree_gist`, and **PGlite does not have
it**. Checked before writing a line, which was worth doing: the alternative was discovering it after
building on the assumption, or worse, shipping a guarantee that only real Postgres enforced while
every test ran on the driver that did not. The resource is folded into the range instead, so one
extension-free constraint carries the guarantee on both drivers. See
[[Engineering Notes#Folding the resource into the range]].

**A platform bug fell out of it.** `undeleteRecords` fired **no DML hooks at all** — not a missing
case, the calls were simply absent. Every engine missed restores: rollups went stale (a gap this
vault had recorded as deliberate), the search index never re-added the record, and a restored
booking would have had no room behind it. Adding `afterSave` and `sideEffects` to that path fixed
all four at once, and the only test that changed was the one documenting the old gap.

**No hang.** The nested-connection rule is now something the design starts from rather than
discovers.

---

## Next

[[Roadmap#16 Model the club domain as metadata|#16]] — the club as a seed org. The booking half now
has an engine to sit on; the counts and the rules still need
[[Open Questions#2 The rulebook PDFs|the rulebook]].

---

Related: [[Roadmap]] · [[Engineering Notes]] · [[Start Here]]
