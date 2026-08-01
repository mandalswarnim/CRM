# Meridian — project context

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

Four commits in; roughly 4,000 lines against a spec that lands nearer 30–40k. What exists is the
interpretive core, built bottom-up with tests (28 passing):

- `server/src/db/` — dual pg/PGlite driver, system + tenant DDL, org provisioning, SF-style IDs
- `server/src/formula/` — formula language lexer/parser/evaluator, ~60 functions
- `server/src/metadata/` — registry, dynamic storage, installer, describe, 16 standard objects
- `server/src/runtime/` — `LimitContext` (governor limits), `RequestContext` (org + user + tenant binding)
- `server/src/auth/`, `server/src/http/` — scrypt login, opaque hashed session tokens, Express app
- `server/src/dml/` — the save pipeline: coercion, validation, recycle bin, cascade, save-order hooks
- `server/src/soql/` — lexer, parser, security rewrite, SQL compiler, executor, queryMore paging
- `server/src/security/` — profiles/permission sets, FLS, OWD + role hierarchy + sharing rules +
  manual shares, enforced in both the query path and the DML path

`installSecurity()` in `security/index.ts` switches the platform from the permissive default policy
to real enforcement; `index.ts` calls it at boot. Tests that need enforcement call it themselves.

- `server/src/http/routes/` — the Salesforce-compatible REST surface: sobjects CRUD, describe,
  upsert by external id, query/queryAll/queryMore, composite (+batch, sobjects, tree), limits, recent

**Milestone reached**: curl drives the platform end to end. Create a record, query it with SOQL,
describe an object, run a composite transaction — all over the wire in Salesforce's shapes.

**Next on the critical path**: DML side effects (#9) — rollups, history, feed, search index —
which fill the hooks the pipeline already exposes, then automation (#10, #11, #12).

Known SOQL gaps, deliberate and documented rather than silently wrong: formula and rollup fields
can be selected but not filtered, sorted or grouped on (they have no stored column); polymorphic
relationship traversal needs `TYPEOF`, which is unimplemented and raises a clear error.

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
