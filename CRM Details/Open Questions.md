---
tags: [blockers, questions]
updated: 2026-08-17
---

# Open Questions

What is unresolved, what it blocks, and who can answer it. **Everything here is waiting on the club,
not on engineering.**

---

## 1. Salesforce replacement strategy

> **Blocks**: [[Roadmap#28 Migrate off Salesforce|#28 migration]] entirely, and reprioritises all of
> Phase F. **Owner**: you.

The club already runs on Salesforce ([[What We Are Building#The strategic situation|Experience
Cloud]]). Which of these is Meridian?

- **Replacement** — Meridian takes over; there is a cutover, a migration, and existing integrations
  must keep working through the compatible API
- **Alongside** — Meridian owns some domains (bookings?) while Salesforce keeps others; needs a
  sync story
- **Cost play** — the point is licence spend, which makes migration fidelity the whole project

Each answer produces a different Phase F. Worth settling before Phase D, because it also decides how
much of [[Roadmap#27 Remaining API compatibility|#27]] matters and in what order.

**Sub-questions once decided:**
- Which existing integrations touch the Salesforce org today?
- Is there a date or event driving the timing?
- Who else has admin access to the current org?

---

## 2. The rulebook PDFs

> **Blocks**: [[Roadmap#16 Model the club domain as metadata|#16]],
> [[Roadmap#17 Encode club rules as metadata|#17]], [[Roadmap#18 Guests and reciprocal visits|#18]].
> **Owner**: you — they are in the office.

The single most important gap is **guest limits**, which you named first and which the public site
never states:

- Maximum guests **per booking**
- Maximum **per member per month / per year**
- Do limits differ by outlet?
- Must the member be present?
- Are guests signed in at the door, or merely named on the booking?

Also needed, from [[Club Domain]]:

| # | Question | Blocks |
|---|---|---|
| a | Bedroom inventory by type | The availability engine has nothing to allocate |
| b | Venue capacities per layout, hire fees, minimum spends | Private hire booking |
| c | Member statuses and **what each one blocks** | Status gating on every booking path |
| d | Subscription renewal cycle and arrears handling | Renewal automation |
| e | Private hire: who approves, deposits, may non-members hire? | Approval process design |
| f | Restaurant: sittings vs rolling, table inventory, walk-ins | Covers model |
| g | Inbound reciprocal rights beyond accommodation | Reciprocal visit rules |
| h | Club scale — member count | Sizing, and migration planning |

---

## 3. Smaller unknowns

Not blocking, but they will need answers before Phase D lands:

- **What runs the club today** besides Salesforce — a PMS for the bedrooms? A restaurant system like
  ResDiary or SevenRooms? Replace or integrate?
- **Historical data** — how much must come across, and how far back?
- **Staff roles and permissions** — reception, reservations, membership secretary, F&B, GM,
  committee. Who sees what?
- **Member self-registration** — do members self-register or does the office issue accounts? How do
  they prove identity?
- **Confirmations** — email only, or SMS too?
- **Hosting and GDPR** — UK data residency required? Where will this run?
- **Team** — is anyone else building on this, or just us?

---

## Answered

Kept so nobody re-asks. Full reasoning in [[Decisions]].

- ✅ Platform, not a club app
- ✅ Both portals — staff console and member portal
- ✅ All three booking types
- ✅ Billing out of scope for now
- ✅ No tier-based access; categories differ on price only
- ✅ Non-members = guests of members + reciprocal club members

---

Related: [[Club Domain]] · [[Roadmap]] · [[Decisions]]
