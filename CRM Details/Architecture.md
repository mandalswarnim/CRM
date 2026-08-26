---
tags: [architecture, reference]
updated: 2026-08-26
---

# Architecture

How the engines fit together. For the aspirational full spec see `docs/architecture.md` in the repo
— but **treat that as a target, not a description**; it was written up front and describes software
that does not all exist. This note describes what is actually built.

## The stack

| Layer | Choice |
|---|---|
| Runtime | Node 20+, TypeScript ESM |
| Web | Express 4 |
| Database | PostgreSQL 14+, or embedded **PGlite** for dev and tests |
| Frontend | React 18 + Vite *(not yet built — [[Roadmap#19 Client foundation\|#19]])* |
| Auth | scrypt, opaque hashed session tokens |
| Search | Postgres `tsvector`, weighted by field kind, maintained on every write |
| Availability | `int8range` exclusion constraint, resource folded into the range |

## Module map

```
server/src/
├── config.ts        environment-sourced config
├── index.ts         boot: migrate → installSecurity → installAutomation → installFlows
│                          → installEffects → installInventory → Scheduler.start
├── db/              dual pg/PGlite driver, system + tenant DDL, provisioning, SF-style IDs
├── util/            SfError (Salesforce wire shapes), 15/18-char ID generation
├── runtime/         LimitContext (governor limits), RequestContext (org + user + tenant)
├── auth/            scrypt login, opaque tokens stored only as SHA-256 hashes
├── metadata/        registry, dynamic storage, installer, describe, 16 standard objects
├── formula/         Salesforce formula language: lexer, parser, evaluator, ~60 functions
├── dml/             the save pipeline + five named hooks
├── soql/            lexer, parser, security rewrite, SQL compiler, executor, paging
├── sosl/            FIND parser, tsquery compiler, search execution, typeahead
├── inventory/       resources, allocations, holds, availability
├── security/        profiles, permission sets, FLS, OWD, role hierarchy, sharing
├── automation/      validation rules, workflow rules, merge fields
├── flow/            JSON DSL interpreter
├── approval/        approval processes, work items, derived record locking
├── effects/         rollups, history, feed, search index, change bus
├── scheduler/       cron parser, advisory-locked tick, job handlers, email dispatch
├── http/            Express app, middleware, REST routes
└── seed/            org provisioning
```

## The save order

Everything hangs off the DML pipeline's five hooks. This is *the* extension mechanism — nothing
should reach into the pipeline itself.

```
insert / update / delete
    │
    ├─ coerce + system-validate (types, required, picklist, lookup, unique)
    ├─ beforeSave    → Flow (before-save, mutates $Record, no extra write)
    ├─ validate      → Validation rules (formula = error condition),
    │                  inventory allocation (losing the last room aborts the save)
    ├─ WRITE
    ├─ afterSave     → Workflow rules, Flow (after-save)
    ├─ sideEffects   → Rollups, history, feed, search index, computed shares
    │                  (all still inside the transaction)
    └─ COMMIT
        └─ afterCommit → change bus publish, email queue drain
```

**Why the split matters**: `sideEffects` runs inside the transaction so a record and its derived
data become visible together. `afterCommit` runs outside so no subscriber ever hears about a record
a rollback is about to remove.

## The query path

```
SOQL text
  → lexer → recursive-descent parser → AST
  → SECURITY REWRITE  ← FLS check, sharing predicate injection
  → SQL compiler       JSONB extraction + casts, parent joins,
                       date literals, aggregates
  → Postgres
  → result shaper      attributes, nested parents, formula evaluation
```

Child subqueries are **not** inlined — they run batched against the parent IDs, which keeps the
generated SQL flat and the row shaping honest.

## Request lifecycle

1. Token (Bearer or `sid` cookie) → `resolveSession` → **`RequestContext`**
2. Context carries: org, schema, user, profile perms, `LimitContext`, resolved access
3. Every tenant statement goes through `ctx.tenant()`, which pins `search_path`
4. Engines take the context — that is what makes tenant binding impossible to forget

## What is not built yet

- **Client** — `client/` is a `package.json` and nothing else
- **OAuth, Bulk, SOAP, streaming** — [[Roadmap#27 Remaining API compatibility|#27]]
- **Reports, dashboards, Setup UI** — Phase D

---

Related: [[Decisions]] · [[Engineering Notes]] · [[Roadmap]]
