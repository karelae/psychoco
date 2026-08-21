# Psychoco — Technical Reference

How Psychoco is built. The domain, the scoring policy, and the fairness rules are
in **[README.md](README.md)**, which is the specification and wins on any
disagreement; this document covers the data model, the scheduling algorithm, the
configuration and audit mechanics, and the technical decisions behind them.

Section references of the form "README §3" point there.

---

## 1. Status and stack

**Design phase. Nothing is implemented.**

No stack has been chosen — not language, framework, datastore, or hosting. That
is deliberate and still open (§6). Two constraints already narrow it, both from
README §7:

- The operator is untrained, changes annually, and needs a real interface for
  every recurring task. No CLI, no config files, no hand-edited data.
- Several people need to see the same board at the same time, from phones and
  laptops.

Together those point firmly at a hosted application with a shared UI rather than
a local or single-user tool, but the decision has not been made.

---

## 2. Domain model

| Entity            | Holds                                                                                                                                              |
|-------------------|----------------------------------------------------------------------------------------------------------------------------------------------------|
| **Person**        | Name, arrival date, departure date, working fraction, any post restrictions (normally none — see README §5.1)                                      |
| **Absence**       | Person, date range, type, whether it reduces availability                                                                                          |
| **DayType**       | Per-date classification (weekday / Friday / Saturday / Sunday / public holiday / protected holiday), from a configurable national holiday calendar |
| **Slot**          | The demand side: a date + a post (1st / 2nd / 3rd). Three per day, every day of the period                                                         |
| **Assignment**    | Slot + person + origin (auto / manual) + reason. What was **planned**                                                                              |
| **WorkedDuty**    | The post a person **actually held** on a date + points + scoring-config version. What the ledger reads                                             |
| **Escalation**    | Date, who dropped out, the resulting shift-up chain, who backfilled the vacant post, reason                                                        |
| **ScoringConfig** | Versioned base weights, multipliers, and constraint parameters, with an effective-from date                                                        |
| **Period**        | 1 Oct – 30 Sep window; the scope of every balance calculation, plus the name of the operator running it (§5)                                       |
| **AuditEntry**    | What changed, when, under which role, under which period's operator. With shared logins, the only record of who did what                           |

### 2.1 Assignment versus WorkedDuty

The split matters enough to state on its own. `Assignment` is the plan;
`WorkedDuty` is what happened, and **only `WorkedDuty` earns points**.

On an undisturbed day the two mirror each other exactly and nobody ever looks at
the distinction. On a disturbed day it is the only thing keeping the ledger
honest: when the escalation chain shifts up (README §1.2), points and the
post-1st rest entitlement both follow the worked post, not the rostered one
(README §2.4).

Collapsing them into one mutable row would make the roster unauditable the first
time somebody called in sick — and drop-outs are routine, not exceptional.

---

## 3. Scoring and configuration

### 3.1 Configuration is data, not code

Weights, multipliers, constraint parameters, and the holiday calendar are all
runtime data with an effective-from date. **Never constants in source.** Two
independent reasons:

- The values are the group's decision and are not yet set (README §2). They will
  be entered, and later adjusted, by an operator through the UI.
- Changing them retroactively changes who is owed what, so the change has to be a
  visible, logged act rather than a deploy.

### 3.2 Pricing and reproducibility

Every `WorkedDuty` records the `ScoringConfig` version it was priced under. So:

- Points are always reproducible from the duty plus its config version.
- Retuning the weights never silently rewrites history.
- A mid-period change is possible but requires an **explicit, logged
  recalculation** — the operator is shown what will move before it moves, and the
  recalculation is an audited event.

### 3.3 Deriving the ledger

`balance` per README §3.2 is a pure function of the `WorkedDuty` rows, the
`Absence` rows, and the `Person` window and fraction, all scoped to a `Period`.
Nothing about a balance should be stored as a mutable running total — it is
derived, so it cannot drift out of step with the duties that produced it.

---

## 4. The scheduler

Given the slots for a period and the current ledger, produce an `Assignment` for
every slot.

### 4.1 Constraint model

The six rules in README §5.1 are the **hard constraints** — coverage, escalation
readiness, one post per person per day, availability, post-1st rest, volume caps.
None may be violated. Coverage is the one that cannot even be traded against the
others: when the constraint set makes a day unfillable, the scheduler must fail
loudly and name the blocking constraint rather than emit an incomplete roster.

### 4.2 What gets traded off

Soft objectives, ranked, with configurable weights:

1. **Running balance.** Minimise squared deviation from expected points, measured
   *continuously* across the period, not at the end of it (README §4). A person
   who leaves in March with a surplus was treated unfairly and cannot be
   compensated afterwards, so an end-of-period objective is the wrong target.
2. **Category parity.** Equal *points* is not sufficient. Two people can land on
   identical totals with one carrying all weekends and the other all weekdays. So
   weekend shifts, holiday shifts, and first calls are each balanced as their own
   count, in addition to the point total.
3. **Spacing.** Spread each person's shifts out rather than clustering them.
4. **Requests.** Honour preferences and swap requests where the above allow.

### 4.3 Approach

Greedy seeding by largest deficit, then local search — pairwise swaps and chain
exchanges — against the weighted objective. This keeps every intermediate state a
valid roster, and every move explainable as "this swap improved balance by X".

A constraint solver (CP-SAT or MIP) is the alternative and would find better
optima. The trade-off is explainability: a solver's answer is "the model says
so", which is exactly the wrong thing to tell someone who thinks they got a raw
deal. Local search is the starting point; the solver stays on the table if the
constraint set outgrows it.

Whichever is used, the requirement of README §5.2 stands: for any slot the system
must be able to name the candidates considered, their balances, and the
constraints that eliminated the rest.

### 4.4 The capacity floor

Worth writing down, because it bounds everything else. Over any *D* days the
posts consume person-days as follows: 1st costs two days per duty (the shift plus
its rest day), 2nd and 3rd cost one each. That is `2D + D + D = 4D` person-days
against a supply of `N × D`, so:

> **N ≥ 4.** Four people is the absolute floor, and it is exactly saturated — a
> 4-day cycle in which everyone works every day and rests every fourth. Three is
> impossible under any arrangement: whoever holds 1st today is out tomorrow,
> leaving two people for three posts.

Utilisation is therefore `4 / N`, tabulated in README §1.1. Allowing for leave
and illness, the real survival floor is five or six; below about ten the rota
dominates everyone's life. **At the actual pool of roughly forty, utilisation is
about 10%** — each person holding around 27 posts a year, of which some 9 are
first calls.

The consequence is worth being explicit about: **coverage is never the binding
constraint here, fairness is.** With that much slack the scheduler has near-total
freedom over who fills each slot, so nothing external forces an uneven
distribution. Any imbalance that shows up is a choice the algorithm made — which
is precisely the case in which a point ledger earns its keep.

### 4.5 Drop-out handling

Recording a drop-out (README §5.3) is three things in one transaction: an
`Escalation` row, the `WorkedDuty` rows for everyone whose post shifted, and an
`Absence` row for the person who dropped out. The original `Assignment` rows are
left untouched — the plan stays visible as what was planned.

Ranking the shortlist for the vacated post uses the same deficit ordering as the
scheduler, filtered to available and escalation-ready people. It is a suggestion:
the operator records who actually took it.

---

## 5. Access, roles and audit

Two shared logins, no per-person identity — a **viewer** role for the group and
an **admin** role for the operator. The reasoning, and what it means for the
group, is in README §7.1. What it requires of the implementation:

- **Admin is a superset of viewer.** One application with two roles, not two
  front ends.
- **Every mutation writes an `AuditEntry`**: what changed, when, under which role,
  and under which period's operator. With a shared credential the log is the
  *only* record of who did what, so it cannot be an afterthought bolted on later.
- **Attribution comes from `Period.operator`.** Only one person operates at a
  time, so the operator's name on the period is what turns "admin did it" into a
  named person.
- **Every mutation records an actor from day one**, even though today that actor
  is only ever a role plus the period's operator. If per-person logins arrive
  later (§6), real identities then extend the audit trail instead of invalidating
  it.
- **The viewer must not be able to read individual `Absence` rows.** It sees
  availability only as a derived count of available days. This is an access rule,
  not a UI choice — the aggregate is all the fairness maths needs.
- **Both passwords rotate at the period boundary.** There is no per-user
  revocation, so rotation on 1 October is the only way to cut off people who have
  left.

---

## 6. Open questions

Technical questions. The ones for the group are in README §9.

- **Where it runs.** Language, framework, datastore, hosting — all open. §1 lists
  the two constraints that narrow it; the decision itself is still to be made
  with the maintainer.
- **Solver or local search.** §4.3 starts with local search for explainability.
  Whether the constraint set eventually justifies CP-SAT or MIP is a question to
  revisit once the volume caps and spacing rules are pinned down.
- **How the swap record works.** README §9 wants swaps recorded rather than
  forbidden. Whether that is a `WorkedDuty` correction, a first-class `Swap`
  entity, or an `Escalation` variant is undecided.
- **Whether per-person logins arrive later.** §5 keeps the door open at the cost
  of one actor field. If operator workload forces it (README §9), the migration
  should be additive.
- **Recalculation scope.** §3.2 requires a logged recalculation when config
  changes mid-period. Whether that reprices every duty in the period or only
  those after the effective-from date is a decision with fairness consequences,
  not just technical ones.
