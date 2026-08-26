---
tags: [index]
updated: 2026-08-26
---

# Meridian — Start Here

The knowledge base for **Meridian**, a metadata-driven CRM platform being built to run
**The Oriental Club** (Stratford House, London W1).

This vault is the *thinking* layer: why things are the way they are, what was learned, what is still
unknown. The code and its reference docs live in the repo alongside it.

> [!important] The one idea to protect
> **The club is data, not code.** Members, bookings, guests and every club rule are ordinary
> platform metadata in a seed org. If something about the club needs a special case in the engine,
> that is a gap in the platform, not a feature.

## Read in this order

1. [[What We Are Building]] — the thesis and the strategic situation
2. [[Decisions]] — what has been settled, and why
3. [[Roadmap]] — all 30 tasks and where they stand
4. [[Architecture]] — how the engines fit together
5. [[Club Domain]] — everything known about the club
6. [[Open Questions]] — what is blocking, and who can answer it

## Working notes

- [[Engineering Notes]] — conventions, and the traps that have already cost time
- [[Session Log]] — what was built when, and what each session learned

## State at a glance

| | |
|---|---|
| Phase | A ✅ · B ✅ · C 🚧 (6/10) · D–F ⬜ |
| Tests | 317 passing |
| Code | ~12,100 lines across 19 modules |
| Branch | `claude/salesforce-crm-clone-g05zeb` |
| Latest | SOSL and global search |

**Next up**: [[Roadmap#15 Booking and inventory engine|#15 the booking engine]] — the one genuinely
hard design problem left, and it needs a decision before any code.

**Blocked on you**: [[Open Questions#1 Salesforce replacement strategy|the Salesforce decision]] and
[[Open Questions#2 The rulebook PDFs|the rulebook PDFs]].
