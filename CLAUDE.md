# Meridian — project context

> **The full knowledge base is the Obsidian vault at `CRM Details/`.** Start at
> `CRM Details/Start Here.md`. It holds the reasoning behind decisions, the club domain, open
> questions, and the traps that have already cost time — read `Engineering Notes.md` before writing
> an engine that calls another engine. This file is the short version; keep both current.

## What this is

A multi-tenant, **metadata-driven CRM platform** modelled on Salesforce, wire-compatible with the
Salesforce REST API. It is being built to run **The Oriental Club** (Stratford House, London W1) —
a private members' club with bedrooms, private event rooms, a dining room and bars.

The key idea, and the thing to protect in every decision:

> **The club is data, not code.** Members, applications, bookings, guests, societies and every club
> rule are ordinary platform metadata in a seed org. If something about the club needs a special
> case in the engine, that is a gap in the platform, not a feature.

The rulebook is still being collected (PDFs pending), so rules must be **configurable metadata**
— validation rules, flows, approval processes — never hardcoded logic. A new rule from a new PDF
should be a config change made in the Setup UI, not a deploy.

## Strategic context

The club **already runs on Salesforce** — its members' area is a Salesforce Experience Cloud site
at `membersarea.orientalclub.org.uk/s/`. So this is a Salesforce *replacement*, which is why
API compatibility matters: it is the migration path and it keeps existing integrations alive.
Whether Meridian replaces, runs alongside, or is purely a cost play is **still undecided** (task #1)
and that decision reprioritises much of the roadmap.

## Scope decisions taken

| Question | Decision |
|---|---|
| Platform or club app? | **Platform.** Build the generic engine; the club is a seed org on top. |
| Users | Two portals over one API: **staff console** and **member portal**. |
| Booking types | **All three** — bedrooms, restaurant/bar tables, private venues — differentiated per portal. |
| Billing | **Out of scope for now.** Track charges; no billing engine yet. |
| Tier-based access | **No.** All members have the same access; categories differ on price, not privileges. |
| Non-members | Guests of members, and **reciprocal club members** (80+ clubs, 25+ countries). |

## Current state

Fourteen commits in; ~13,000 lines of source
and ~5,850 of tests, against a spec that lands nearer 30–40k. **354 tests passing.** Phases A–B are
complete and Phase C is 7/10 — the whole interpretive core plus the automation stack on top of it:

- `server/src/db/` — dual pg/PGlite driver, system + tenant DDL, org provisioning, SF-style IDs
- `server/src/formula/` — formula language lexer/parser/evaluator, ~60 functions
- `server/src/metadata/` — registry, dynamic storage, installer, describe, 16 standard objects
- `server/src/runtime/` — `LimitContext` (governor limits), `RequestContext` (org + user + tenant binding)
- `server/src/auth/`, `server/src/http/` — scrypt login, opaque hashed session tokens, Express app
- `server/src/dml/` — the save pipeline: coercion, validation, recycle bin, cascade, save-order hooks
- `server/src/soql/` — lexer, parser, security rewrite, SQL compiler, executor, queryMore paging
- `server/src/sosl/` — `FIND {…}` parser, tsquery compiler, search execution, typeahead
- `server/src/inventory/` — bookable resources, allocation, holds, availability
- `server/src/security/` — profiles/permission sets, FLS, OWD + role hierarchy + sharing rules +
  manual shares, enforced in both the query path and the DML path
- `server/src/effects/` — rollup summaries, field history, tracked-change feed items, tsvector
  search index, post-commit change bus
- `server/src/automation/` — validation rules, workflow rules; field-filter and formula criteria,
  field updates (re-validated), email alerts, tasks, outbound messages, time-based triggers
- `server/src/flow/` — JSON-DSL flow interpreter: assignment, decision, loop, get/create/update/
  delete records, email, post to feed, subflow; record-triggered before- and after-save
- `server/src/approval/` — entry criteria, multi-step chains with skip conditions,
  user/manager/queue/role approvers, unanimity, record locking, recall, history
- `server/src/scheduler/` — cron parser, advisory-locked multi-org tick, time-based workflow
  triggers, scheduled flows, recycle-bin purge, weekly CSV export, email dispatch (.eml or SMTP)
- `server/src/http/routes/` — the Salesforce-compatible REST surface: sobjects CRUD, describe,
  upsert by external id, query/queryAll/queryMore, composite (+batch, sobjects, tree), limits,
  recent, `/process/approvals`, `/search`, `/parameterizedSearch`, `/search/suggestions`,
  `/inventory/resources`, `/inventory/availability`, `/inventory/reservations`

Five engines register against the DML hooks — security, effects, automation, flow, inventory — via
`installSecurity()`, `installEffects()`, `installAutomation()`, `installFlows()`,
`installInventory()`. `index.ts` calls all five at boot; before that the permissive default policy
is what runs, so **tests that need enforcement must call the installers themselves**.

Approval is the exception: record locking is enforced from inside `dml/pipeline.ts`, which reaches
into `approval/engine.ts` for `lockedRecordIds()` through a dynamic import to break the cycle. It
is the one place an engine is wired into the pipeline rather than onto a hook — worth knowing
before assuming the hook list is the whole story.

**Milestone reached**: curl drives the platform end to end. Create a record, query it with SOQL,
describe an object, run a composite transaction — all over the wire in Salesforce's shapes. The
automation stack is verified end to end too: a validation rule blocks a save, a before-save flow
stamps a field, an approval chain routes through two steps and fires a field update on approval,
and history, feed and search index all follow the write.

**Next on the critical path**: modelling the club domain as metadata (#16). The booking half now
has an engine to sit on — bedrooms, covers and venues are `inventory_resource` rows — but the
counts and the rules are blocked on the rulebook PDFs.

**Booking availability is a generic engine configured by metadata** (`server/src/inventory/`), which
is how the club stays data. A resource is either `exclusive` (one allocation at a time — the
Wellington Suite, the Boardroom) or a `pool` (N units per grain step — King rooms, Dining Room
covers). `Booking__c` is an ordinary metadata object whose `booking` config names which fields mean
resource, start and end; a DML hook allocates in the `validate` stage, so losing the race for the
last room aborts the save rather than leaving a booking with no room behind it.

PGlite has no `btree_gist`, so the textbook `EXCLUDE (resource_id WITH =, span WITH &&)` cannot be
built there. The resource is folded into the range instead — each one owns a band of the number
line at `ordinal × STRIDE` — so a single `EXCLUDE USING gist (span WITH &&)` needs no extension and
behaves identically on both drivers. Do not "simplify" this back to the textbook form; the tests
would stop enforcing the guarantee.

**The gap between the code and the stated goal**: automation is configured by inserting rows into
tenant tables (`validation_rule`, `workflow_rule`, `flow_def`, `approval_process`). There is no
setup REST surface and no Setup UI, so a new rule from a new PDF is still a developer job today.
Closing that is #26, currently behind the whole of Phase D.

**Search is not its own security model.** SOSL resolves matching ids from `search_index`, then
re-queries each object through the ordinary SOQL compiler with those ids ANDed into the caller's
`WHERE` — so sharing and FLS are inherited, never reimplemented. `runQueryAst()` exists so SOSL can
hand over a prepared AST rather than build query text. Search groups (`IN NAME FIELDS`, …) are
tsvector weight masks: A name, B text, C email, D phone. Changing what gets indexed leaves written
rows stale, so `reindexSearch` (a scheduled job kind) rebuilds from the records.

Known SOQL gaps, deliberate and documented rather than silently wrong: **formula** fields can be
selected but not filtered, sorted or grouped on (they have no stored column, and they evaluate
against the row as shaped — so a formula's source fields must also be in the SELECT list or it
reads them as blank). Rollups are *not* in this category: they are maintained in the JSONB body on
every child write, so they filter and sort normally. Polymorphic relationship traversal needs
`TYPEOF`, which is unimplemented and raises a clear error.

`docs/architecture.md` is a **specification written up front**, not a description of built
software. Treat it as the target, and check the code before believing any claim in it. The same
goes for `README.md`, which documents commands that do not all work yet.

## Architectural rules

1. **Every tenant-scoped statement goes through `withTenantClient`** — it pins `search_path` to the
   org schema. There are no cross-tenant queries, ever.
2. **`LimitContext` threads through every engine call.** Defined early on purpose: retrofitting it
   into thousands of lines of signatures later is a rewrite.
3. **Security is a rewrite pass in the SOQL compiler**, not a filter over results. Sharing
   predicates are injected into the AST before SQL generation; FLS rejects unreadable fields with
   `INVALID_FIELD`, as the Salesforce API does. The hook exists from the compiler's first commit.
4. **Describe is the single source of truth** for both the API response and the UI. Build it right
   and the record UI is generated rather than written.
5. **Errors use `SfError`** from `util/errors.ts` so the wire shape stays Salesforce-compatible.

## The one thing metadata does not give you free

**Booking availability.** Everything else about the club is comfortably rows-and-metadata, but
preventing two staff double-booking the Wellington Suite needs a real allocation model with
database-level exclusion constraints — nightly room inventory, restaurant covers per service
period, time-slot holds on venues. This is a first-class design problem (task #15), not a
`Booking__c` implementation detail.

## Club facts established (from the public site)

- **Categories**: Full, Associate (partners of Full Members), OC7/OC7+ (33 affiliated schools),
  Family Scheme — crossed with **Town / Country / Overseas** and age bands 18‑25, 26‑29, 30‑34, 35+.
- **Application**: proposed and seconded by two members each with **12+ months' standing**, who know
  the candidate personally; form + headshot; waiting list; Membership Sub-Committee; limited
  elections per year.
- **Bedrooms**: Single, Double, King, Superior King, Junior Suite, Wellington Suite. Open to members,
  guests *staying at the same time as a member*, and reciprocal members. A room may only be shared
  by a Member with another Member or Associate. Cancellation: 100% of first night inside 1 day,
  50% inside 2 days.
- **Venues**: Library & Ante Room, Main Drawing Room, Smoking Rooms, Boardroom.
- **Outlets** with distinct hours: Dining Room, Calcutta Light Horse Bar (closed Sundays),
  Members' Bar (Tue–Fri only), Hill Station / Folly / Terrace (vacate by 10pm).
- **Other rules**: children 10+ (4+ at family events), smoking in the Courtyard only, dress code and
  device bans vary by room.
- **15 societies**; **80+ reciprocal clubs** requiring letters of introduction from Reservations.

Still unknown: actual guest limits per booking and per member per period, bedroom count, member
count, room capacities and hire fees. See `docs/club-domain.md`.

## Commands

```bash
npm install     # needs --cache <dir> under a sandbox that blocks ~/.npm
npm test        # server test suite (vitest)
npm run seed    # provision an org into embedded PGlite
npm run dev     # server :4000, client :5173
```

The client is currently only a `package.json` — no Vite config, no source. `npm run dev` will not
start a client until task #19.

## Conventions

- TypeScript ESM throughout; **`.js` extensions on relative imports** (required by Node ESM).
- Tests are vitest, run against ephemeral in-memory PGlite (`createEphemeralDb`).
- British English in user-facing copy; `en_GB`, `Europe/London`, GBP are the org defaults.
