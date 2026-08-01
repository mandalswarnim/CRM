# Meridian — roadmap

The plan of record for building the platform and the Oriental Club org on top of it.
**Keep this file up to date as work lands** — it is the shared view of where the project is.

Status: ✅ done · 🚧 in progress · ⬜ not started

Last updated: 1 August 2026 · 196 tests passing · ~8,200 lines

---

## Where we are

Phases A and B are complete: **curl drives the platform end to end**. A working Salesforce-compatible
API server with metadata-driven storage, a real query language, and enforced security.

| Phase | What it delivers | Status |
|---|---|---|
| A — Make it run | Server boots, DML and SOQL work | ✅ |
| B — First verifiable milestone | Security enforced, REST API live | ✅ |
| C — Platform behaviours | Rollups, automation, scheduling, search | ⬜ |
| D — The face | Client, record UI, staff console, member portal | ⬜ |
| E — Compatibility surface | OAuth, Bulk, SOAP, streaming | ⬜ |
| F — Proof and polish | Club org, migration, lifecycle, deployment | ⬜ |

---

## Decisions taken

| Question | Decision |
|---|---|
| Platform or club app? | **Platform.** Build the generic engine; the club is a seed org on top. |
| Users | Two portals over one API: **staff console** and **member portal**. |
| Booking types | **All three** — bedrooms, restaurant tables, private venues. |
| Billing | **Out of scope for now.** Track charges; no billing engine. |
| Tier-based access | **No.** All members have the same access; categories differ on price. |
| Non-members | Guests of members, and **reciprocal club members** (80+ clubs, 25+ countries). |

---

## Tasks

### Blocking decisions

| # | Task | Status |
|---|---|---|
| 1 | **Decide Salesforce replacement strategy.** The club already runs on Salesforce (`membersarea.orientalclub.org.uk/s/` is Experience Cloud). Replace, run alongside, or licence-cost play? Reprioritises much of what follows. | ⬜ |
| 2 | **Write the club domain spec.** Drafted at [club-domain.md](club-domain.md) from the public site. Open pending the rulebook PDFs: guest limits, bedroom inventory, member statuses, renewal cycle, private-hire approval, restaurant sittings, inbound reciprocal rights, club scale. | 🚧 |

### Phase A — Make it run

| # | Task | Status |
|---|---|---|
| 3 | **Runtime spine.** Express app, per-request tenant binding, `LimitContext`, Salesforce error shapes, scrypt login with hashed opaque session tokens. | ✅ |
| 4 | **DML pipeline.** Salesforce save order, 21 field types coerced and validated, auto-numbers, compound names, master-detail cascade, recycle bin, five named automation hooks. | ✅ |
| 5 | **SOQL engine.** Lexer, parser, security rewrite, SQL compiler over JSONB, parent joins, child subqueries, aggregates, 27 date literals, queryMore paging. | ✅ |
| 6 | **Bootstrap seed and dev login.** `npm run seed` provisions an org with an admin user. | ✅ |

### Phase B — First verifiable milestone

| # | Task | Status |
|---|---|---|
| 7 | **Security model.** Profiles and permission sets, FLS, org-wide defaults, role hierarchy, sharing rules materialised into `record_share`, manual shares, `ControlledByParent`. Enforced in both the query path and the DML path. | ✅ |
| 8 | **REST API surface.** sobjects CRUD, describe, upsert by external id, query/queryAll/queryMore, composite (+batch, sobjects, tree), limits, recent. | ✅ |

### Phase C — Platform behaviours

| # | Task | Status |
|---|---|---|
| 9 | **DML side effects.** Rollup summaries (stored, so filterable and sortable), field history, Chatter tracked-change feed items, tsvector search index, post-commit change bus. | ✅ |
| 10 | **Validation and workflow rules.** Where the first real club rules become enforceable config rather than code. | ⬜ |
| 11 | **Flow engine.** JSON DSL interpreter: record-triggered, scheduled, autolaunched. | ⬜ |
| 12 | **Approval processes.** First use: the membership application chain — proposer and seconder, then Membership Sub-Committee. | ⬜ |
| 13 | **Scheduler.** Advisory-lock job runner: time-based triggers, scheduled flows, recycle-bin purge, weekly export. | ⬜ |
| 14 | **SOSL and global search.** | ⬜ |
| 15 | **Booking and inventory engine.** ⚠️ The one piece metadata does not give free — correct availability needs a real allocation model with database-level exclusion constraints. Nightly room inventory, restaurant covers per service period, time-slot holds on venues. Design task, not an implementation detail. | ⬜ |
| 16 | **Model the club domain as metadata.** Membership, applications, bookings, guests, reciprocals, societies. No club-specific engine code. | ⬜ |
| 17 | **Encode club rules as configurable metadata.** Guest limits, member status gates, accommodation eligibility and the Member/Associate sharing rule, cancellation windows, children 10+, outlet hours as booking windows. | ⬜ |
| 18 | **Guests and reciprocal visits.** Letters of introduction, per-club restrictions, inbound visitor tracking. | ⬜ |

### Phase D — The face

| # | Task | Status |
|---|---|---|
| 19 | **Client foundation.** `client/` is currently only a `package.json` — needs Vite config, SLDS-style design system, routing, auth, and the staff/member split. | ⬜ |
| 20 | **Metadata-driven record UI.** Record homes, related lists, edit forms generated from describe + layout. The payoff for building describe early. | ⬜ |
| 21 | **Navigation, list views, Kanban.** App Launcher, global search, Classic theme toggle, responsive for tablets. | ⬜ |
| 22 | **Staff operations console.** Arrivals/departures, service-period covers, venue diary, guest sign-in, application pipeline. Role-scoped. | ⬜ |
| 23 | **Member portal.** Book a room or table, enquire about private hire, RSVP, join societies, request a letter of introduction. The sharing model's real test. | ⬜ |
| 24 | **Communications.** Email templates, confirmations, reminders — driven by workflow and flow, not code. | ⬜ |
| 25 | **Reports and dashboards.** Run as the running user. Membership pipeline, renewals, occupancy, covers, venue utilisation. | ⬜ |
| 26 | **Setup UI.** Object Manager, Flow Builder, users/profiles/permission sets. What lets staff add a rule from a new PDF without a developer. | ⬜ |

### Phase E — Compatibility surface

| # | Task | Status |
|---|---|---|
| 27 | **Remaining API compatibility.** OAuth 2.0 with connected apps, Bulk 2.0 CSV, SOAP + WSDL, SSE streaming. Independent of each other; priority depends on which existing Salesforce integrations must keep working. | ⬜ |

### Phase F — Proof and polish

| # | Task | Status |
|---|---|---|
| 28 | **Migrate off the existing Salesforce org.** Extract, map, load via the API-compatible surface. Scope depends entirely on task 1. | ⬜ |
| 29 | **Lifecycle tooling.** Sandbox cloning, change sets, packaging, weekly export. | ⬜ |
| 30 | **Deployment, hardening, docs.** `deploy/`, Postgres over PGlite, backups, GDPR and UK hosting, plus the four docs the README links but that do not exist. | ⬜ |

---

## Known gaps, deliberate

Recorded so nobody mistakes them for oversights:

- **Formula fields** can be selected but not filtered, sorted or grouped on — nothing is stored.
  Raises `MALFORMED_QUERY` rather than returning wrong rows. (Rollups are now stored and queryable.)
- **Undelete does not re-run rollups**, so a restored child is counted again only on its next save.
- **Polymorphic relationship traversal** needs `TYPEOF`; unimplemented, raises a clear error.
- **Duplicate external ids within one batch** are caught by the database unique index rather than
  the pre-check, so the whole batch fails instead of the one record. Data stays correct.
- **`npm run dev`** starts no client until task 19.
- **`npm install`** needs `--cache <dir>` under a sandbox that blocks `~/.npm`.
