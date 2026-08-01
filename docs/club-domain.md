# The Oriental Club — domain specification

The business the platform must express. Everything here becomes **metadata in the seed org** —
objects, fields, validation rules, flows, approval processes — never engine code.

**Status**: drafted from the public website (July 2026). Items marked ❓ are unresolved and await
the club's rulebook PDFs. Do not guess at them in code; leave them configurable with a sensible
default and a comment pointing here.

---

## 1. Membership

### Categories

| Category | Notes |
|---|---|
| Full | The standard category. Requires proposer + seconder. |
| Associate | Partners of Full Members. Identical club privileges and member room rates. |
| OC7 / OC7+ | Graduates of 33 affiliated schools (Eton, Harrow, Charterhouse, Wellington…). £2,000 entrance fee waived. |
| Family Scheme | Relatives of existing members. Entrance fee waived. |

Every membership is also banded on **location** and **age**, which together determine the
subscription. Location is a rule, not a free choice:

- **Town** — within 100 miles of the clubhouse, *or* regularly doing business in London
- **Country** — 100+ miles away, or continental Europe
- **Overseas** — beyond continental Europe

Age bands: 18‑25, 26‑29 (graduated year by year), 30‑34, 35+.

2026 subscriptions run £460 (Overseas 18‑25) to £2,680 (Town 35+); Associates £540 flat;
OC7/Family £450–£1,100. Entrance fee £2,000 where not waived.

> Modelling note: category, location band and age band are three separate dimensions that resolve
> to a rate. Keep them as separate fields with the rate derived, not one flattened picklist —
> members move between bands as they age and relocate, and the rate card changes annually.

❓ When are subscriptions due — common renewal date or joining anniversary?
❓ What happens on non-payment, and after how long?

### Application process

1. Candidate is **proposed and seconded by two existing members**, each a member for **more than
   twelve months**, both of whom know the candidate personally.
2. Application form submitted, plus a **headshot photograph** to the Membership Team.
3. Candidate joins the **waiting list**.
4. **Membership Sub-Committee** reviews. The club elects a limited number of new members each year.

This is the approval process the platform must express (task #12): two confirmations, then a
committee decision, with the candidate parked on a waiting list in between.

❓ Timescales at each step; what causes an application to stall or lapse.
❓ Does the committee ballot formally (thresholds, blackballs) or simply decide?
❓ Is there an interview or club tour stage that gets recorded?

### Member lifecycle

❓ The full status list is unconfirmed. At minimum: candidate → waiting list → elected → current,
plus lapsed, suspended, resigned and deceased. Each status must declare **what it blocks** —
booking, guest sign-in, portal access — because that gating is the rule the booking engine consults.

---

## 2. Guests and reciprocal members

### Guests

Guests may stay in the bedrooms **only when staying at the same time as a member**. Beyond that:

❓ **Guest limits are the club's first-named rule and are not published.** Needed: maximum guests
per booking, maximum per member per month/year, whether limits differ by outlet, whether the member
must be present, and whether guests are signed in at the door or merely named on the booking.

### Reciprocal clubs

- 80+ clubs across 25+ countries (Australia, Canada, France, Hong Kong, India, Ireland, Japan,
  Kenya, Malaysia, New Zealand, Singapore, Sri Lanka, Spain, Switzerland, Thailand, USA, UK).
- **Outbound**: a member visiting a reciprocal club must obtain a **letter of introduction** from
  the Oriental Club, requested through the Members' Area and issued by Reservations.
- Per-club variation matters and must be data: some clubs have **no accommodation**; the Hong Kong
  Club requires the visitor **not be ordinarily resident in Hong Kong**.
- **Inbound**: reciprocal members may book accommodation. A 12.5% discretionary service charge
  applies to reciprocal and guest room reservations.

❓ What else may an inbound reciprocal member book — dining, events? Are their visits capped?
❓ How is an inbound reciprocal visitor verified on arrival?

---

## 3. Accommodation

Room types: **Single, Double, King, Superior King, Junior Suite, Wellington Suite**. All en-suite,
with complimentary continental breakfast.

**Eligibility** — members, their guests (staying concurrently with the member), and reciprocal club
members.

**Sharing rule** — "a bedroom may only be shared by a Member with another Member or an Associate
Member." This is a genuine validation rule on the booking's occupants.

**Cancellation** — within 1 day of arrival: 100% of the first night. Within 2 days: 50% of the first
night. Amended stays incur the equivalent penalty against the revised departure date.

Rates vary by weekday/weekend and by month across the year; a 12.5% discretionary service charge
applies to reciprocal and guest reservations.

❓ How many bedrooms of each type — this is the inventory the availability engine allocates.
❓ Check-in and check-out times; minimum and maximum stay; how far ahead booking opens.
❓ Deposit requirements.

---

## 4. Dining and bars

| Outlet | Hours |
|---|---|
| Dining Room | Breakfast 07:00–10:00 weekdays, 08:00–10:30 weekends; Lunch 12:30–14:30 weekdays; Dinner 18:00–21:30 weekdays |
| Calcutta Light Horse Bar | Mon–Fri 11:00–24:00; Sat 11:00–22:00; **closed Sundays** |
| Members' Bar | **Tue–Fri only**, 11:30–14:00 and 18:00–20:00 |
| Hill Station / Folly / Terrace | Must be vacated by 22:00 |

Opening hours are **booking windows** — a reservation outside them is invalid. They differ per
outlet and per day of week, so they must be data on the outlet, not constants.

❓ Table inventory and covers per service; fixed sittings or rolling seating; floor-plan/table
assignment needed?; how walk-ins are recorded.

---

## 5. Private dining and events

Rooms: **Library & Ante Room, Main Drawing Room, Smoking Rooms, Boardroom**.

The flow runs enquiry → proposal → confirmation → event, driven from a "Make an Enquiry" form today.

❓ Capacities per layout (dinner, reception, boardroom, theatre); hire fees and minimum spends;
who approves a booking; whether non-members may hire; deposit and contract terms; how catering and
setup requirements are captured.

---

## 6. Club events and societies

**15 societies**: Music, Bridge, Game Shooting, Cricket, Chess, Wine, Snooker and Billiards, Golf,
U35, Racing, Battlefield Tour, Curry, Library (and others listed on the site). Members join through
the Members' Area; each society runs its own calendar.

There is a club-wide events calendar and a weekly activities programme.

❓ Do societies have their own membership rules, fees or capacity?
❓ Do events ticket and take payment, and may members bring guests to them?

---

## 7. House rules

These are advisory rather than blocking, but they belong on confirmations and in the member portal:

- **Dress code** — Dining Room and Members' Bar: elegantly casual, **tailored jacket required**
  (except Planters' Orders, where a collared shirt suffices). Elsewhere: smart casual. Prohibited
  throughout: sportswear, shorts, short-sleeved collared shirts, t-shirts, vest tops, large logos,
  scruffy trainers, flip-flops.
- **Devices** — electronic devices, business papers and briefcases are **not allowed** in the Dining
  Room, Members' Bar or Billiards Room. Permitted in the Drawing Rooms, Smoking Rooms, Business Room
  and Boardroom.
- **Children** — 10+ generally; 4+ at designated family events such as the Family Christmas Lunch.
- **Smoking** — Courtyard only, including e-cigarettes; never in bedrooms.

Model these as attributes of the **area/outlet**, so a booking confirmation can state the dress code
and device policy that applies where the member is going.

---

## 8. Open questions summary

Blocking the club metadata work (tasks #16–#18), not the platform work:

1. Guest limits — per booking and per member per period
2. Bedroom inventory by type; venue capacities by layout
3. Member statuses and what each one blocks
4. Subscription renewal cycle and arrears handling
5. Private hire: approval, deposits, whether non-members may hire
6. Restaurant: sittings vs rolling, table inventory, walk-ins
7. Reciprocal inbound rights beyond accommodation
8. Scale — member count, for sizing and for migration planning
