---
tags: [roadmap, status]
updated: 2026-08-26
---

# Roadmap

30 tasks, six phases. Mirrors `docs/roadmap.md` in the repo — **update both when work lands.**

Status: ✅ done · 🚧 in progress · ⬜ not started

| Phase | Delivers | Status |
|---|---|---|
| **A** Make it run | Server boots, DML and SOQL work | ✅ |
| **B** First milestone | Security enforced, REST API live | ✅ |
| **C** Platform behaviours | Rollups, automation, scheduling, search, bookings | 🚧 7/10 |
| **D** The face | Client, record UI, staff console, member portal | ⬜ |
| **E** Compatibility | OAuth, Bulk, SOAP, streaming | ⬜ |
| **F** Proof and polish | Club org, migration, lifecycle, deployment | ⬜ |

**354 tests passing · ~13,000 lines · branch `claude/salesforce-crm-clone-g05zeb`**

---

## Blocking decisions

### 1 Salesforce replacement strategy ⬜
Replace, run alongside, or licence-cost play? Reprioritises Phase F.
→ [[Open Questions#1 Salesforce replacement strategy]]

### 2 Club domain spec 🚧
Drafted in [[Club Domain]] from the public site. Open pending the rulebook PDFs.
→ [[Open Questions#2 The rulebook PDFs]]

---

## Phase A — Make it run ✅

### 3 Runtime spine ✅
Express app, per-request tenant binding, `LimitContext`, Salesforce error shapes, scrypt login with
hashed opaque session tokens.

### 4 DML pipeline ✅
Salesforce save order, 21 field types coerced and validated, auto-numbers, compound names,
master-detail cascade, recycle bin, five named hooks.

### 5 SOQL engine ✅
Lexer, parser, security rewrite, SQL compiler over JSONB, parent joins, child subqueries, aggregates,
27 date literals, queryMore paging.

### 6 Bootstrap seed ✅
`npm run seed` provisions an org with an admin user.

---

## Phase B — First verifiable milestone ✅

### 7 Security model ✅
Profiles and permission sets, FLS, org-wide defaults, role hierarchy, sharing rules materialised into
`record_share`, manual shares, `ControlledByParent`. Enforced in both query and DML paths.

### 8 REST API surface ✅
sobjects CRUD, describe, upsert by external ID, query/queryAll/queryMore, composite (+batch,
sobjects, tree), limits, recent.
**Milestone: curl drives the platform end to end.**

---

## Phase C — Platform behaviours 🚧

### 9 DML side effects ✅
Rollup summaries (stored, so filterable and sortable), field history, tracked-change feed items,
tsvector search index, post-commit change bus.

### 10 Validation and workflow rules ✅
Field-filter and formula criteria, three trigger types, field updates (re-validated), email alerts,
tasks, outbound messages, time-based triggers.
**The first real club rules became configuration.**

### 11 Flow engine ✅
JSON DSL interpreter — assignment, decision, loop, get/create/update/delete records, email, post to
feed, subflow. Record-triggered before-save and after-save, limit-accounted, cycle-guarded.

### 12 Approval processes ✅
Entry criteria, multi-step chains with skip conditions, user/manager/queue/role approvers, unanimity,
derived record locking, recall, full history, `/process/approvals` REST surface.
**Test fixtures are the club's actual membership application chain.**

### 13 Scheduler ✅
Cron parser, advisory-locked multi-org tick, time-based workflow triggers, outbound messages,
scheduled flows, recycle-bin purge, weekly CSV export, email dispatch (.eml or SMTP).

### 14 SOSL and global search ✅
`FIND {…}` parser (phrases, AND/OR/NOT, trailing wildcards), the four search groups, `RETURNING`
with per-object WHERE / ORDER BY / LIMIT, `/search`, `/parameterizedSearch` and a
`/search/suggestions` typeahead. **39 tests.**

The index moved to a **weighted** tsvector — A name, B text, C email, D phone — so a search group is
a weight mask rather than a second table. `reindexSearch` (a scheduled job) rebuilds it, which is
how a change to what gets indexed reaches records nobody has touched since.

**Security is inherited, not reimplemented**: the index answers *which records match*, then each
object is re-queried through the SOQL compiler, so sharing and FLS apply exactly as they do to a
SOQL query. See [[Engineering Notes#Search reuses the query path on purpose]].

### 15 Booking and inventory engine ✅

> [!warning] The one thing metadata does not give free
> Everything else about the club is comfortably rows-and-metadata. Availability is not. Preventing
> two staff double-booking the Wellington Suite needs a **real allocation model with
> database-level exclusion constraints** — not JSONB and validation rules.

**Design decision taken**: a *generic allocation engine* whose configuration is metadata — which
resolves the "engine or object type?" question rather than picking a side. `server/src/inventory/`
owns `inventory_resource`, `inventory_allocation` and `inventory_usage`; `Booking__c` stays an
ordinary metadata object that declares `booking` wiring. The engine has never heard of a bedroom.
See [[Decisions#Booking is a generic engine configured by metadata]].

Two resource shapes cover all three booking types:

| Mode | Enforced by | The club's cases |
|---|---|---|
| `exclusive` | range exclusion constraint | Wellington Suite, Boardroom, Library & Ante Room |
| `pool` | per-step counter with `CHECK (taken <= ceiling)` | King rooms, Dining Room covers, Members' Bar |

Also: holds with expiry, configurable overbooking, opening hours as booking windows (data on the
resource — the Members' Bar really is Tuesday to Friday), an availability query, a REST surface,
and an `expireHolds` scheduled job. **37 tests**, including two that race concurrent bookings for
the last slot and assert exactly one wins.

> [!danger] PGlite has no `btree_gist`
> The textbook `EXCLUDE (resource_id WITH =, span WITH &&)` **cannot be built on the embedded
> driver**, so the resource is folded into the range instead. See
> [[Engineering Notes#Folding the resource into the range]].

### 16 Model the club domain as metadata ⬜ ← **next**
Membership, applications, bookings, guests, reciprocals, societies. No club-specific engine code.
The booking half now has an engine to sit on: bedrooms, covers and venues are `inventory_resource`
rows. *Still blocked on the rulebook for the counts and the rules.*

### 17 Encode club rules as metadata ⬜
Guest limits, member status gates, accommodation eligibility and the Member/Associate sharing rule,
cancellation windows, children 10+, outlet hours as booking windows. *Blocked on the rulebook.*

### 18 Guests and reciprocal visits ⬜
Letters of introduction, per-club restrictions, inbound visitor tracking. *Blocked on the rulebook.*

---

## Phase D — The face ⬜

### 19 Client foundation ⬜
`client/` is currently **only a `package.json`**. Needs Vite config, `index.html`, tsconfig, an
SLDS-style design system, routing, auth, and the staff/member split.

### 20 Metadata-driven record UI ⬜
Record homes, related lists, edit forms generated from describe + layout.
**The payoff for building describe early.**

### 21 Navigation, list views, Kanban ⬜
App Launcher, global search, Classic theme toggle, responsive for tablets.

### 22 Staff operations console ⬜
Arrivals/departures, service-period covers, venue diary, guest sign-in, application pipeline.
Role-scoped.

### 23 Member portal ⬜
Book a room or table, enquire about private hire, RSVP, join societies, request a letter of
introduction. **The sharing model's real test.**

### 24 Communications ⬜
Email templates, confirmations, reminders — driven by workflow and flow, not code.
*(Transport and dispatch already exist from #13.)*

### 25 Reports and dashboards ⬜
Run as the running user. Membership pipeline, renewals, occupancy, covers, venue utilisation.

### 26 Setup UI ⬜
Object Manager, Flow Builder, users/profiles/permission sets.
**What lets staff add a rule from a new PDF without a developer** — the payoff for choosing the
platform route.

---

## Phase E — Compatibility ⬜

### 27 Remaining API compatibility ⬜
OAuth 2.0 with connected apps, Bulk 2.0 CSV, SOAP + WSDL, SSE streaming. Independent of each other;
priority depends entirely on which existing Salesforce integrations must keep working — see
[[Open Questions#1 Salesforce replacement strategy|task 1]].

---

## Phase F — Proof and polish ⬜

### 28 Migrate off Salesforce ⬜
Extract, map, load via the API-compatible surface. CSV data loader CLI, reconciliation reporting,
dry run before cutover. **Scope depends entirely on task 1.**

### 29 Lifecycle tooling ⬜
Sandbox cloning, change sets, packaging, weekly export.
*Needed before the club runs on this for real, so config can be tested outside production.*

### 30 Deployment, hardening, docs ⬜
`deploy/` (Docker, compose, k8s), Postgres over PGlite, backups, GDPR and UK hosting, plus the four
docs the README links but that do not exist.

---

Related: [[Start Here]] · [[Open Questions]] · [[Session Log]]
