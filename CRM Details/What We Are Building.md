---
tags: [thesis, context]
updated: 2026-08-17
---

# What We Are Building

Not a CRM. **A platform that a CRM is then configured on top of** — the Salesforce trick,
reproduced.

## The thesis, in three moves

### 1. Metadata is data, not code

Objects, fields, layouts, validation rules, automation and reports are *rows in tables*, interpreted
at runtime. Creating a custom object is an `INSERT` that triggers `CREATE TABLE` on the fly. There is
no build step, no deploy, no restart — ever.

This is why the club's rules can arrive from a PDF next month and become a config change rather than
a release.

### 2. Describe is the single source of truth

One metadata description drives both the REST API response *and* every pixel of the record UI. Build
the describe layer correctly and the UI is largely generated rather than written. That is why
`describe.ts` existed before any UI did.

### 3. The club is a fixture, not a feature

The Oriental Club org — memberships, events, bookings, guests — is *ordinary platform metadata* in a
seed script. It exists to prove the engine can express a real business without a line of domain code.
If the club ever needs special-case code, the platform has failed.

## Wrapped around that

- **Hard multi-tenancy** — one Postgres schema per org, `search_path` pinned per request
- **Wire-compatible APIs** — `/services/data/v61.0/*` in Salesforce's exact shapes
- **Security inside the query compiler** — sharing as an injected predicate, not a filter on results
- **Governor limits** — per-transaction budgets threaded through every engine

## Explicit non-goals

Apex, Visualforce, Einstein, real SAML signature validation. Recorded here so nobody adds them by
accident.

## The strategic situation

> [!warning] The club already runs on Salesforce
> The members' area at `membersarea.orientalclub.org.uk/s/` is a Salesforce **Experience Cloud**
> site. The `/s/` path gives it away.

This is therefore a **Salesforce replacement**, not a greenfield build. Which changes things:

- API compatibility stops being academic — it is the migration path and it keeps existing
  integrations alive
- There is real production data to move, and a real cutover to plan
- The question of *why* — cost, control, capability — is still unanswered, and it reprioritises
  everything in Phase F

See [[Open Questions#1 Salesforce replacement strategy]].

## What "done" looks like

Two portals over one API:

- **Staff console** — reception, reservations, membership secretary, F&B, committee
- **Member portal** — book a bedroom, reserve a table, enquire about private hire, RSVP to events,
  join societies, request a letter of introduction for a reciprocal club

Both are views onto the same metadata-driven engine. Neither has club logic in it.

---

Related: [[Decisions]] · [[Architecture]] · [[Club Domain]]
