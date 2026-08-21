# Psychoco

A shift-distribution system for a rotating pool of psychiatry co-assistants.

Psychoco turns "who does the next on-call shift?" from a negotiation into a
calculation. It scores every shift by how demanding it actually is, keeps a
running ledger per person, and generates a roster that spreads the real burden
evenly across everyone available — including the people who arrive halfway
through the year and the people who leave before it ends.

> **Looking for the technical side?** The data model, the scheduling algorithm,
> the constraint and configuration mechanics, and the access and audit design are
> in **[TECHNICAL-README.md](TECHNICAL-README.md)**. This document covers what
> the system does and why the distribution is fair — the part the group has to
> agree on. It deliberately contains no implementation detail.

---

## 1. The domain

### 1.1 How a day is staffed

Every single day of the year carries three simultaneous on-call posts, and all
three must be filled:

| Post    | Weekday                                                                                                              | Weekend and public holiday                               | Consequences next day                                   |
|---------|----------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------|---------------------------------------------------------|
| **1st** | In the hospital and working during the day, and working all night                                                    | In the hospital and working, a full 24 hours             | next day is a rest day — no post at all                 |
| **2nd** | In the hospital and working during the day, also on call — reachable, backs up the 1st when the workload spills over | Comes in to the hospital for check-ups, backs up the 1st | next day is a normal post day — no rest day entitlement |
| **3rd** | In the hospital and working during the day, also on call in case of escalation — reachable                           | On call — reachable                                      | next day is a normal post day — no rest day entitlement |

Demand is therefore fixed and fully known in advance: **three posts per calendar
day, every day — 1,095 slots per period.** There is no flexing the number of
shifts. The only question is who fills them.

Note that for this amount of shifts the more people you have the less this will dominate your life. The table below illustrates this:

| Pool   | Utilisation | Shifts/yr | 1st calls/yr |
|--------|-------------|-----------|--------------|
| 4      | 100%        | 274       | 91           |
| 6      | 67%         | 183       | 61           |
| 8      | 50%         | 137       | 46           |
| 12     | 33%         | 91        | 30           |
| 20     | 20%         | 55        | 18           |
| **40** | **10%**     | **27**    | **9**        |

*Shifts/yr* counts all three posts together, not just first calls, and
*utilisation* is the share of the year a person spends either on duty or on a
post-1st rest day. Four people is the hard floor, and it is exactly saturated —
no free days at all, ever. The derivation is in
[TECHNICAL-README §4.4](TECHNICAL-README.md#44-the-capacity-floor).

### 1.2 Escalation: everyone moves up

If the 1st drops out — illness, most often — the roster does not go looking for
a like-for-like replacement. Everyone below shifts up a post: the **2nd becomes
1st, the 3rd becomes 2nd**, and someone new is needed only at 3rd, the lightest
post.

Two consequences shape the whole system:

**Nobody is rostered to a post they could not step up from.** Being on 3rd is
not a beginner's post — it is one drop-out away from 2nd and two from 1st.
Whoever holds 3rd has to be able to run a first call.

**What you were rostered for and what you actually worked can differ.** A 3rd
who ends the night as 1st did a first call, and the ledger has to say so or the
scoring is a fiction. See §2.4.

### 1.3 The problem

On-call shifts are not interchangeable. A first-level call on Christmas Day and
a third-level call on a quiet Tuesday are the same line in a spreadsheet and
nothing alike in real life. Distribute shifts by counting them and you get a
roster that is arithmetically equal and obviously unfair — the person who drew
three weekend firsts carries several times the load of the person who drew
three midweek thirds.

The pool also churns. Co-assistants rotate in and out continuously, take leave,
sit exams, and work different fractions. Any fairness rule that assumes a fixed
group present for a fixed period breaks immediately.

Psychoco addresses both: **weight each shift by its true cost**, then
**balance those weights against how much of the period each person was
actually there**.

---

## 2. Core idea: the point ledger

Every completed shift credits its assignee with points. Points are a measure of
burden carried, not of hours worked. Higher total = has done more of the group's
unpleasant work.

```
points(shift) = base(level) × multiplier(day type)
```

Two independent factors, multiplied. Level captures the clinical weight of the
shift; day type captures what it costs you socially to be on it.

> **The numbers in §2.1 and §2.2 are placeholders.** The actual values get fixed
> later, by the group, and every figure in the examples that follow moves with
> them. What is being decided here is the *shape* of the scoring — two factors,
> multiplied, with the higher day-type multiplier winning outright — not the
> constants. Read the tables as a worked illustration of that shape.

### 2.1 Base weight by level

| Level | Role                                                           | Base  |
|-------|----------------------------------------------------------------|-------|
| 1st   | First call — primary responsibility, highest volume and acuity | **6** |
| 2nd   | Second call — backup and escalation                            | **3** |
| 3rd   | Third call — lightest duty, rarely disturbed                   | **1** |

The gaps are deliberately wide and non-linear. A first-level shift is not
"somewhat harder" than a third — it is a different job, and the weights say so.
One first-level shift is worth six third-level shifts.

### 2.2 Day-type multiplier

| Day type                                     | Multiplier |
|----------------------------------------------|------------|
| Monday – Thursday                            | **1.0**    |
| Friday                                       | **1.2**    |
| Saturday                                     | **1.5**    |
| Sunday                                       | **1.5**    |
| Public holiday                               | **1.8**    |
| Protected holiday (24/25 Dec, 31 Dec, 1 Jan) | **2.2**    |

**Stacking rule: multipliers do not compound. The highest applicable multiplier
wins.** A Sunday that is also a public holiday scores 1.8, not 1.5 × 1.8 = 2.70.
Compounding produces runaway values on exactly the dates that matter most and
makes the ledger impossible to reason about.

### 2.3 What that yields

| Shift                   | Calculation | Points |
|-------------------------|-------------|--------|
| 3rd, Tuesday            | 1 × 1.0     | 1.0    |
| 3rd, Saturday           | 1 × 1.5     | 1.5    |
| 3rd, Christmas Day      | 1 × 2.2     | 2.2    |
| 2nd, Tuesday            | 3 × 1.0     | 3.0    |
| 2nd, Saturday           | 3 × 1.5     | 4.5    |
| 2nd, Christmas Day      | 3 × 2.2     | 6.6    |
| 1st, Tuesday            | 6 × 1.0     | 6.0    |
| 1st, Friday             | 6 × 1.2     | 7.2    |
| 1st, Saturday or Sunday | 6 × 1.5     | 9.0    |
| 1st, public holiday     | 6 × 1.8     | 10.8   |
| 1st, Christmas Day      | 6 × 2.2     | 13.2   |

On these placeholder values the spread between the lightest and heaviest shift
comes out at **13.2×**. Whatever the group finally sets, a spread of roughly that
order is the point of the exercise — it is the gap a plain shift count throws
away.

> These nine numbers are the system's entire value judgement. They get **hard-set
> by the group before the first roster is generated**, and then left alone for
> the rest of the period. They are configuration, not code — see
> [TECHNICAL-README §3](TECHNICAL-README.md#3-scoring-and-configuration) for how
> a mid-period change is handled, and [§7](#7-operating-model-and-handover) for
> who can make one.

### 2.4 Points follow the duty actually worked

Points are credited for the post a person **actually held**, not the post they
were rostered to. When the chain shifts up (§1.2), the ledger shifts with it:

| Person | Rostered | Worked | Credited (a Saturday) |
|---|---|---|---|
| P | 1st | dropped out | 0.0 |
| Q | 2nd | **1st** | 6 × 1.5 = **9.0** |
| R | 3rd | **2nd** | 3 × 1.5 = **4.5** |
| S | — | **3rd** (called in) | 1 × 1.5 = **1.5** |

Anything else corrupts the ledger. Credit the roster instead and Q carries a
first call for the price of a second — permanently, with the system insisting it
was fair.

Three knock-on rules:

- **The rest day follows worked duty, not rostered duty.** Since only a 1st earns
  a rest day (§5.1), an escalation moves the entitlement: Q, rostered to 2nd,
  worked a 1st and is now owed tomorrow off, which the roster never planned for.
  R, who stepped up to 2nd, gets no rest day. P, who dropped out, needs none.
  Applying rest to the roster instead would hand the day off to the wrong person
  and leave the one who actually worked the night on duty.
- **A drop-out day also leaves the dropper's availability.** P scores nothing,
  and the day is recorded as absence, so P's expected share drops with it (§3.1).
  Being ill is not a debt.
- **Escalations are recorded events** — date, who dropped out, the resulting
  chain — not silent edits to the original assignment. The roster stays visible
  as what was planned; the ledger says what happened.

---

## 3. Fairness: points per available day

Equal totals are the wrong target. Someone present for three months should
carry a quarter of the load of someone present for the full year, not the same.

So the unit of fairness is **points per available day**.

### 3.1 Availability

A person's *available days* are the days in the period on which they were both
a member of the pool (between arrival and departure) and not on recorded
absence, scaled by their working fraction:

```
availableDays(p) = (days in pool − days absent) × fraction(p)
```

Recorded absence covers leave, exams, congress, illness, and any rotation
elsewhere. Each absence type carries a flag for whether it reduces availability —
some genuinely should, and some (a single day off in lieu) arguably should not.

### 3.2 Expected share and balance

Given the pool's total points distributed so far:

```
targetRate  = Σ points(p)  /  Σ availableDays(p)
expected(p) = targetRate × availableDays(p)
balance(p)  = points(p) − expected(p)
```

`balance` is the number the whole system runs on:

- **Negative** → this person is *owed* burden. They are next in line.
- **Positive** → this person has carried more than their share.
- **Near zero** → fair.

Because `balance` is denominated in points, it is directly comparable to the
cost of an actual shift. A balance of −9 says: this person is owed roughly one
first-level Sunday.

### 3.3 Worked example

A 92-day stretch, three people:

| Person | In pool         | Absence       | Available days |
|--------|-----------------|---------------|----------------|
| A      | all 92 days     | —             | 92             |
| B      | joins on day 32 | —             | 61             |
| C      | all 92 days     | 14 days leave | 78             |

Total available days = 231. Total points distributed = 462.
So `targetRate` = 462 / 231 = **2.0 points per available day**.

| Person | Expected | Actual | Balance   |
|--------|----------|--------|-----------|
| A      | 184.0    | 200.0  | **+16.0** |
| B      | 122.0    | 100.0  | **−22.0** |
| C      | 156.0    | 162.0  | **+6.0**  |

B is owed the most and takes the next heavy shift — despite having the *lowest*
raw total, and despite having done fewer shifts than everyone else. That is the
system working: B has been present for two-thirds as long and should carry
two-thirds as much.

---

## 4. The scheduling year

**The period runs 1 October – 30 September, and every balance resets to zero on
1 October.** The pool turns over substantially between periods; carrying debts
across a boundary would mean settling them against a different set of people.

Two consequences worth stating plainly:

**Arrivals and departures are the normal case, not the exception.** Someone
joining in February starts at zero and is immediately expected to carry only a
February-to-September share. No catching up, no head start.

**Fairness has to hold continuously, not just on 30 September.** A person who
leaves in March with a +40 balance has been treated unfairly and it can never be
repaired — there is no remaining period in which to correct it. So the scheduler
optimises for the balance staying tight *throughout* the period, not for a tidy
final tally. This rules out any strategy that loads someone up early and
compensates later.

---

## 5. What any roster must satisfy

Psychoco generates complete rosters: given the slots to fill and the current
ledger, it produces an assignment for every one of them.

### 5.1 The rules

These hold without exception. A roster that breaks any of them is not a roster.

1. **Coverage.** All three posts are filled on every single day of the period
   (§1.1). Non-negotiable; if the rules make coverage impossible, the scheduler
   must report *which* one blocks it rather than quietly leaving a hole.
2. **Escalation readiness.** Because the chain shifts up on a drop-out (§1.2),
   whoever is on 2nd must be able to run a 1st and whoever is on 3rd must be
   able to run a 2nd. In practice the pool is qualified for all three posts, and
   any individual restriction has to be respected at *every* post rather than
   only at 1st.
3. **One post per person per day.**
4. **Availability.** No assignment during recorded absence or outside the
   person's arrival–departure window.
5. **Post-call rest — after a 1st only.** A first call is followed by a rest day
   on which the person takes no post at all. Second and third calls carry no rest
   day; someone can hold 3rd on consecutive days, or 3rd then 2nd. This asymmetry
   matters more than it looks — it is what sets the minimum workable pool size
   ([TECHNICAL-README §4.4](TECHNICAL-README.md#44-the-capacity-floor)).
6. **Volume caps.** Maximum shifts per week and per month; minimum gap between
   weekend shifts.

Everything beyond these is a trade-off rather than a rule — balance, the mix of
weekends and holidays each person gets, spacing, and honouring requests. How
those are weighed against one another is in
[TECHNICAL-README §4.2](TECHNICAL-README.md#42-what-gets-traded-off).

### 5.2 Explainability and override

**Every assignment carries its reason.** For any slot, the system can answer
"why this person?" with the balances of the candidates considered and the
constraints that eliminated the rest. A roster nobody can interrogate is a
roster nobody will accept, however good the maths.

**Any assignment can be overridden by hand**, with a recorded reason. The
override is respected as a fixed point, and the ledger recomputes around it.
The system advises; it does not overrule the people using it.

### 5.3 Drop-outs on the day

A drop-out is not a re-planning exercise, it is a decision someone has to make
in two minutes at seven in the morning. Psychoco's job is to make it fast and
defensible: record the drop-out, apply the escalation chain automatically, and
hand the operator a ranked shortlist for the one post that is now vacant —
available, escalation-ready, largest deficit first. A human makes the call; the
system records who actually took it and re-prices the day per §2.4.

---

## 6. Design decisions

### 6.1 Multiply, don't add
Level and day type are independent dimensions of cost, so they multiply. A
first-level shift being on a Sunday is worse in proportion to how bad a
first-level shift already is. Additive weights would flatten exactly the
distinction that makes the system worth building.

### 6.2 Highest multiplier wins
Per §2.2 — compounding day-type multipliers explodes on the dates that matter
most and destroys the intuition that a number in the ledger can be checked by
hand.

### 6.3 Balance is a rate, not a total
Per §3. Every alternative — equal counts, equal totals, equal weekends —
punishes part-time work and mid-period arrival, which describes most of the pool.

### 6.4 No carry-over between periods
Per §4. Debts settle against the group that incurred them.

### 6.5 Explain first, optimise second
Per §5.2. This tool's real constraint is social acceptance, not scheduling
optimality. A roster that is 5% less balanced but wholly transparent beats the
reverse.

### 6.6 Operable by whoever inherits it
Per §7. The person running Psychoco changes every year and will not have been
trained by the last one. Every recurring task — new cohort, new period,
drop-out, override — has to be doable from the interface by someone seeing it
for the first time. No config files, no command line, no tribal knowledge.

The decisions behind the data model, the algorithm, and the access design are in
[TECHNICAL-README](TECHNICAL-README.md).

---

## 7. Operating model and handover

Psychoco is maintained by one person and *operated* by someone else — and the
operator changes every year. At the start of each period a member of the
incoming cohort takes it over: they enter the new list of colleagues, start the
period, generate the roster, and handle drop-outs and overrides for twelve
months. Then they rotate out and hand it to the next one.

Nobody trains them. There is no support rota, and no expectation that the
maintainer is reachable at three in the morning when the 1st calls in sick.

That turns "operable by a stranger" into a hard requirement:

- **Starting a period is self-service.** Creating the new period and entering
  the incoming cohort is a guided task in the interface — not a database
  migration, a seed script, or a hand-edited file.
- **No configuration lives outside the app.** Weights, multipliers, constraint
  parameters, and the holiday calendar are all editable by the operator in the
  UI.
- **Destructive actions are recoverable.** Removing a person mid-period,
  regenerating a published roster, retuning weights — a first-time operator will
  do all of these by accident. Each needs a confirmation stating what will
  change, and a way back.
- **The app explains itself.** The scoring rules and the reason behind any given
  assignment are visible in the interface (§5.2), because that is where the
  questions get asked. Not in this README, which the operator will never read.
- **Handover is a feature, not a conversation.** Closing a period, archiving it
  read-only, and opening the next one is an explicit, supported action.

### 7.1 Two accounts, not forty

Access is two shared logins: a **viewer** account for the group, and an **admin**
account for whoever is operating this period. There is no per-person identity.

This is the right trade, and not merely the cheap one:

**A shared viewer forces full transparency.** With no personal login the app
cannot show you a private view, so it shows everyone the same one — every
balance, every expected share, the whole roster. That is what a fairness system
needs. People believe the numbers because they can check everyone else's, not
just their own; a private "here is your score" screen would invite exactly the
suspicion the ledger exists to remove.

**A shared admin still attributes.** Only one person operates at a time, so "the
admin did it" identifies someone — as long as the app records who is operating
this period.

What that means for the group in practice:

- **Everyone sees the same board.** Every balance, every expected share, the
  whole roster, for everybody.
- **Nobody sees individual absence records.** Balances and rosters are public by
  design; "R was off sick 3–7 March" is not the group's business. The viewer sees
  availability as a count of available days, which is all the fairness maths
  needs anyway.
- **Both passwords change on 1 October**, as part of the handover. A viewer
  password shared across forty rotating people will leak, and rotation is the
  only way to cut off everyone who has left.
- **No self-service.** Absences, preferences, and swap requests all go through
  the operator, because the app cannot tell who is asking. At forty people that
  is a steady trickle of messages rather than a flood, and it is the main thing
  to watch — if it becomes the operator's actual job, per-person logins are the
  fix.

The role and audit mechanics are in
[TECHNICAL-README §5](TECHNICAL-README.md#5-access-roles-and-audit).

---

## 8. Non-goals

- **Not a payroll or time-tracking system.** Points measure burden, not hours,
  and are not an input to anyone's pay.
- **No clinical or patient data.** Psychoco stores names, dates, levels, and
  absence categories. Nothing about patients ever enters it, and absence reasons
  stay coarse — "leave", not a diagnosis.
- **Not a general rostering tool.** It solves this pool's on-call distribution.
  Day-shift planning, holiday approval, and leave workflows stay wherever they
  live now.
- **Not an authority.** It proposes; humans decide and can always override.

---

## 9. Open questions

Questions for the group. The technical ones are in
[TECHNICAL-README §6](TECHNICAL-README.md#6-open-questions).

- **Setting the nine numbers.** Deferred by design — the group fixes the weights
  and multipliers later, and §2 carries placeholders until they do. Two things to
  put in front of them when the time comes. First, whether the day-type
  multiplier alone can price a weekend 1st, given that it is a full 24 hours
  against a weekday's night: one multiplier is currently doing two jobs, pricing
  the lost weekend *and* roughly double the hours, and the alternative is
  separate weekday and weekend base weights per post. Second, whether a holiday
  *eve* deserves a multiplier of its own.
- **Does a short-notice call-in cost extra?** When the chain shifts up, someone
  gets called in at the vacant post with no warning. Normal points for that post,
  or a premium for the disruption?
- **Partial credit for a drop-out mid-shift.** Someone who works until 02:00 and
  then goes home ill currently scores nothing. Probably acceptable; worth
  confirming rather than discovering.
- **Swaps after publication.** Two people trading shifts privately is normal and
  healthy, and it moves points between them. The ledger needs to see it — which
  likely means recording the swap rather than forbidding it.
- **Holiday calendar.** Defaulting to the Belgian national calendar, plus
  whatever local closures the department observes.
- **When does self-service become necessary?** §7.1 routes every absence,
  preference, and swap through the operator, since shared logins cannot tell who
  is asking. At forty people that should be a manageable trickle — but it is a
  guess. Worth measuring over one period rather than pre-building per-person
  accounts for a problem that may not appear.

---

## Status

Design phase. No implementation yet — the model above is the thing to agree on
first.
