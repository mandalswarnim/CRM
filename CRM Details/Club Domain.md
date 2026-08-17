---
tags: [domain, club]
updated: 2026-08-17
source: orientalclub.org.uk (public site, July 2026)
---

# Club Domain — The Oriental Club

Everything known about the business the platform must express. **All of this becomes metadata in the
seed org — never engine code.**

Items marked ❓ are unresolved and await [[Open Questions#2 The rulebook PDFs|the rulebook PDFs]].
Do not guess at them in code; leave them configurable with a sensible default and a comment.

**Address**: Stratford House, 11 Stratford Place, London W1C 1ES
**Members' area**: `membersarea.orientalclub.org.uk/s/` ← Salesforce Experience Cloud

---

## Membership

### Categories

| Category | Notes |
|---|---|
| **Full** | The standard category. Requires proposer + seconder. |
| **Associate** | Partners of Full Members. Identical privileges and member room rates. |
| **OC7 / OC7+** | Graduates of 33 affiliated schools (Eton, Harrow, Charterhouse, Wellington…). £2,000 entrance fee waived. |
| **Family Scheme** | Relatives of existing members. Entrance fee waived. |

Crossed with **location** and **age band**, which together determine the subscription.

**Location is a rule, not a choice:**
- **Town** — within 100 miles of the clubhouse, *or* regularly doing business in London
- **Country** — 100+ miles away, or continental Europe
- **Overseas** — beyond continental Europe

**Age bands**: 18–25, 26–29 (graduated year by year), 30–34, 35+

2026 subscriptions run **£460** (Overseas 18–25) to **£2,680** (Town 35+). Associates £540 flat.
OC7/Family £450–£1,100. Entrance fee £2,000 where not waived.

> [!tip] Modelling note
> Category, location band and age band are **three separate dimensions** that resolve to a rate.
> Keep them as separate fields with the rate derived — members age and relocate, and the rate card
> changes annually. A flattened picklist would need rewriting every year.

❓ Renewal cycle — common date or joining anniversary?
❓ What happens on non-payment, and after how long?

### Application process

1. Proposed and seconded by **two existing members**, each a member **more than twelve months**,
   both of whom know the candidate personally
2. Application form + **headshot photograph** to the Membership Team
3. Candidate joins the **waiting list**
4. **Membership Sub-Committee** reviews; a limited number are elected each year

This is implemented in [[Roadmap#12 Approval processes|#12]] — the test fixtures already use this
exact shape.

❓ Timescales at each step; what makes an application stall or lapse
❓ Does the committee ballot formally (thresholds, blackballs) or simply decide?
❓ Is there an interview or club tour stage to record?

### Lifecycle

❓ **The status list is unconfirmed.** At minimum: candidate → waiting list → elected → current, plus
lapsed, suspended, resigned, deceased. Each status must declare **what it blocks** — booking, guest
sign-in, portal access — because that gating is what the booking engine consults.

---

## Guests and reciprocals

### Guests

Guests may stay in bedrooms **only when staying at the same time as a member**.

> [!warning] The first-named rule is still unknown
> ❓ Guest limits are the rule you flagged first and they are **not published**. Needed: max per
> booking, max per member per month/year, whether limits differ by outlet, whether the member must
> be present, and whether guests are signed in at the door or merely named on the booking.

*(The test fixtures currently assume six per booking and member-must-accompany-for-dining as
placeholders. Both are config, not code.)*

### Reciprocal clubs

- **80+ clubs across 25+ countries** — Australia, Canada, France, Hong Kong, India, Ireland, Japan,
  Kenya, Malaysia, New Zealand, Singapore, Sri Lanka, Spain, Switzerland, Thailand, USA, UK
- **Outbound**: a member visiting must obtain a **letter of introduction**, requested through the
  Members' Area and issued by Reservations
- **Per-club variation must be data**: some have **no accommodation**; the Hong Kong Club requires
  the visitor **not be ordinarily resident in Hong Kong**
- **Inbound**: reciprocal members may book accommodation; 12.5% discretionary service charge applies

❓ What else may an inbound reciprocal member book — dining, events? Are visits capped?
❓ How is an inbound visitor verified on arrival?

---

## Accommodation

**Room types**: Single · Double · King · Superior King · Junior Suite · **Wellington Suite**
All en-suite, complimentary continental breakfast.

**Eligibility** — members, their guests (staying concurrently), and reciprocal club members.

**Sharing rule** — *"a bedroom may only be shared by a Member with another Member or an Associate
Member."* A genuine validation rule on the booking's occupants.

**Cancellation**:
- Within **1 day** of arrival → **100%** of the first night
- Within **2 days** → **50%** of the first night
- Amended stays incur the equivalent against the revised departure date

Rates vary by weekday/weekend and by month. 12.5% service charge on reciprocal and guest bookings.

❓ **How many bedrooms of each type** — this is the inventory the availability engine allocates
❓ Check-in/out times; min and max stay; how far ahead booking opens; deposits

---

## Dining and bars

| Outlet | Hours |
|---|---|
| **Dining Room** | Breakfast 07:00–10:00 wkdys, 08:00–10:30 wknds · Lunch 12:30–14:30 wkdys · Dinner 18:00–21:30 wkdys |
| **Calcutta Light Horse Bar** | Mon–Fri 11:00–24:00 · Sat 11:00–22:00 · **closed Sundays** |
| **Members' Bar** | **Tue–Fri only**, 11:30–14:00 and 18:00–20:00 |
| **Hill Station / Folly / Terrace** | Vacate by 22:00 |

> [!tip] Hours are booking windows
> A reservation outside them is invalid. They differ per outlet *and* per day of week, so they must
> be data on the outlet, not constants.

❓ Table inventory and covers per service; fixed sittings or rolling; floor plan needed?; walk-ins

---

## Private dining and events

**Rooms**: Library & Ante Room · Main Drawing Room · Smoking Rooms · Boardroom

Flow runs enquiry → proposal → confirmation → event.

❓ Capacities per layout (dinner, reception, boardroom, theatre); hire fees and minimum spends; who
approves; whether non-members may hire; deposits and contract terms; catering and setup capture

---

## Events and societies

**15 societies**: Music · Bridge · Game Shooting · Cricket · Chess · Wine · Snooker and Billiards ·
Golf · U35 · Racing · Battlefield Tour · Curry · Library *(and others)*

Members join through the Members' Area; each runs its own calendar. There is a club-wide events
calendar and a weekly activities programme.

❓ Do societies have their own membership rules, fees or capacity?
❓ Do events ticket and take payment? May members bring guests?

---

## House rules

Advisory rather than blocking, but they belong on confirmations and in the portal.

- **Dress code** — Dining Room and Members' Bar: elegantly casual, **tailored jacket required**
  (except Planters' Orders, where a collared shirt suffices). Elsewhere smart casual.
  Prohibited throughout: sportswear, shorts, short-sleeved collared shirts, t-shirts, vest tops,
  large logos, scruffy trainers, flip-flops
- **Devices** — electronic devices, business papers and briefcases **not allowed** in the Dining
  Room, Members' Bar or Billiards Room. Permitted in Drawing Rooms, Smoking Rooms, Business Room,
  Boardroom
- **Children** — 10+ generally; 4+ at designated family events such as the Family Christmas Lunch
- **Smoking** — Courtyard only, including e-cigarettes; never in bedrooms

> [!tip] Model these on the area, not globally
> So a booking confirmation can state the dress code and device policy for wherever the member is
> going.

---

Related: [[Open Questions]] · [[Roadmap]] · [[What We Are Building]]
