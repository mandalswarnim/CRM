# Meridian CRM Platform

A self-contained, multi-tenant, **metadata-driven CRM platform** modeled on Salesforce
(Lightning Experience + Classic), wire-compatible with the Salesforce REST API surface — shipped
with a fully configured sample org for a **London private members' club**: members, applications,
renewals, events & RSVPs, dining/room bookings, guest visits, invoicing, and communications.

## Quick start (embedded DB — zero infrastructure)

```bash
npm install
npm run seed          # provisions the sample club org into an embedded PGlite database
npm run dev           # server on :4000, client on :5173
```

Log in at http://localhost:5173 — credentials are printed by the seed step
(default `admin@larkspur.club` / `Larkspur#1905`).

## Quick start (PostgreSQL)

```bash
createdb crm_platform
export DATABASE_URL=postgres://crm:crm@localhost:5432/crm_platform
npm install && npm run seed && npm run dev
```

Or `docker compose -f deploy/docker-compose.yml up` for the full stack. Kubernetes manifests are
in `deploy/k8s/`. Full runbook: [docs/deployment.md](docs/deployment.md).

## What's inside

- **Metadata engine** — objects, fields (formula, rollup, dependent picklists, master-detail…),
  layouts, record types, validation rules defined as data and interpreted at runtime; custom
  objects create their storage on the fly.
- **SOQL/SOSL** — real parser + SQL compiler (parent joins, child subqueries, aggregates, date
  literals) with sharing & field-level security enforced in the query path.
- **Salesforce-shape APIs** — `/services/data/v59.0/*` (sobjects, describe, query, composite,
  limits), OAuth 2.0, Bulk 2.0 CSV jobs, SOAP login/query/CRUD + WSDL, streaming events (SSE).
- **Automation** — validation rules, workflow rules, Flow with visual builder, approval
  processes, email templates & alerts, email-to-case, scheduled jobs.
- **Analytics** — report builder (tabular/summary/matrix, charts) and dashboards, run as the
  viewing user.
- **Security** — profiles, permission sets, FLS, org-wide defaults, role hierarchy, sharing
  rules, manual sharing; governor limits per transaction.
- **Lightning-style UI** — App Launcher, global search, list views + Kanban, record homes with
  related lists/activity/chatter/files, Setup (Object Manager, Flow Builder, users/profiles…),
  Classic theme toggle, responsive mobile layout.
- **Lifecycle** — sandbox org cloning, change-set metadata deploys, package export/install,
  CSV data loader, weekly export.

## Documentation

| Doc | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Stack, topology, multitenancy, engine design, scaling |
| [docs/deployment.md](docs/deployment.md) | Local, Docker, Kubernetes runbooks; env vars; seed data |
| [docs/api.md](docs/api.md) | REST/SOAP/Bulk/Streaming usage with curl examples |
| [docs/admin-guide.md](docs/admin-guide.md) | Setup UI: objects, fields, layouts, flows, security |
| [docs/parity-matrix.md](docs/parity-matrix.md) | Honest feature-by-feature parity statement |

## Repository layout

```
server/   TypeScript backend — engines, APIs, migrations, tests (vitest)
client/   React SPA — Lightning + Classic themes, Setup UI, builders
scripts/  dataloader CLI, weekly export
deploy/   Dockerfiles, docker-compose, k8s manifests
docs/     architecture, deployment, API, admin, parity
```
