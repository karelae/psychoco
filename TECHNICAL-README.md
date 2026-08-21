# Psychoco — Technical Reference

How Psychoco is built. The domain, the scoring policy, and the fairness rules are
in **[README.md](README.md)**, which is the specification and wins on any
disagreement; this document covers the data model, the scheduling algorithm, the
configuration and audit mechanics, and the technical decisions behind them.

Section references of the form "README §3" point there.

---

## 1. Stack and deployment

### 1.1 Status

**First implementation exists.** The scoring, fairness and scheduling logic is
written and under test; the Sheet I/O, setup, validation, operator menu and
read-only board are written but can only be exercised by deploying. Nothing has
run a real period yet.

### 1.2 The stack

| Layer | Choice |
|---|---|
| Datastore | **A Google Sheet.** One tab per entity (§2) |
| Logic | **Google Apps Script** (V8), plain JavaScript |
| Operator interface | The Sheet itself, plus a **Psychoco menu** for every recurring task |
| Group interface | An **Apps Script Web App** serving a read-only board |
| Access control | Google sharing, plus an email allowlist on the People tab |
| Audit | Drive revision history, plus an `Audit` tab written by every mutation |
| Backups | Drive revision history |
| Source of truth for code | This repository, pushed with `clasp` |
| Tests | Node's built-in runner against the framework-free modules |
| Hosting | None. There is no server, no container, no database and no bill |

The layout mirrors that split deliberately:

```
apps-script/
  00_schema.gs      constants, civil-date and fixed-point helpers   — pure
  10_scoring.gs     points = base x multiplier                      — pure
  20_fairness.gs    availability, expected share, balance           — pure
  30_scheduler.gs   constraints, greedy seed, local search          — pure
  40_sheet.gs       the only file that touches SpreadsheetApp
  50_setup.gs       builds the workbook
  60_validate.gs    invariant checks
  70_menu.gs        the operator's actions
  80_webapp.gs      the read-only board
  board.html
test/               Node tests for 00-30
```

**`00_schema.gs` through `30_scheduler.gs` touch no Apps Script API at all.**
They are ordinary JavaScript, which is what lets `test/harness.mjs` load them
into a `vm` context and test them under Node. Apps Script has no test runner, so
this separation is the only thing standing between the fairness maths and
deploy-and-see. Everything from `40_sheet.gs` up is kept thin for the same
reason.

### 1.3 Deployment

There is no server, so "deploying" means two separate things: getting the code
into the Sheet's bound script, and publishing a version of the board. They are
not the same action and confusing them is the most likely early mistake.

**What gets deployed.** Only `apps-script/` — `clasp` pushes the directory named
as `rootDir` in `.clasp.json`, so `test/`, `scripts/` and `preview/` never leave
the machine. `.clasp.json` itself is gitignored: it holds the script id of one
specific deployment, which is local state rather than shared source.

**`appsscript.json` is the deployment configuration.** Three values in it carry
weight:

| Field | Value | Why |
|---|---|---|
| `timeZone` | `Europe/Brussels` | Every Sheet `Date` is converted through this zone (§1.6) |
| `webapp.executeAs` | `USER_DEPLOYING` | The board must read a Sheet its readers cannot open |
| `webapp.access` | `ANYONE` | Readers must be signed in, so the email allowlist has an identity to check (§5) |

Because the manifest declares the `webapp` block, a CLI deployment picks those
settings up — there is no need to set them by hand in the editor dialog.

**The commands** (clasp 3.x; `create`, `deploy` and friends remain as aliases):

```bash
npx @google/clasp@3 login                                  # once, in a browser
npx @google/clasp@3 create-script --type sheets --title Psychoco --rootDir apps-script
npx @google/clasp@3 push                                   # upload code
npx @google/clasp@3 create-deployment --description "..."   # publish a board version
npx @google/clasp@3 open-web-app                            # get the URL
npx @google/clasp@3 pull                                    # if someone edited in the browser
```

**Push and deploy are not the same, and this will catch you out.** After a
`push`:

- the **menu** runs the new code immediately, because a container-bound script
  executes whatever is currently saved;
- the **board** keeps serving the last *deployed version*, and does not change
  until `create-deployment` runs.

So a fix to the scheduler is live for the operator the moment it is pushed, while
a fix to the board is invisible to the group until it is deployed. Version your
deployments with a description; `list-versions` and `update-deployment` are the
rollback path.

**Authorization happens once**, the first time a menu function runs, and Google
prompts the owning account to grant the script access to its own spreadsheet.
Viewers are never prompted, because the board runs as the deploying account
rather than as them — which is worth knowing, since a permissions dialog is
exactly what stops people using a tool.

**Whichever account runs `login` owns everything.** The Sheet is created in that
account's Drive and the board runs as it. That makes the choice of account a
governance decision, not a convenience: a dedicated account handed on with the
operator role each October keeps forty colleagues' data out of an individual's
personal Drive and lets the tool outlive its current maintainer (§6).

The click-by-click walkthrough, including what to fill in and in what order,
is in [SETUP.md](SETUP.md). This section covers the model; that covers the steps.

### 1.4 Why a spreadsheet rather than a hosted application

A Go application with Postgres was designed and then rejected. The reasoning is
worth keeping, because it will be re-litigated:

- **Operability.** README §7 makes an untrained, annually-rotating operator a
  hard requirement. A spreadsheet is the most operable interface that exists for
  that population, at zero build cost.
- **Backups.** A lost ledger cannot be reconstructed — nobody can reproduce who
  worked which post across nine months. Drive revision history solves this
  outright, with no cron job, no object storage and no restore drill.
- **Audit.** Revision history records who changed which cell, under a real
  Google identity. A shared-login application could only ever record "the admin
  did it".
- **Neglect resistance.** This was the argument that originally favoured a
  compiled binary, and on closer inspection it points the other way: a VM the
  maintainer personally owns is the least neglect-resistant part of any such
  design. Here there is no OS to patch, no TLS to renew and no database to
  upgrade.
- **Shipping at all.** The likeliest failure of a solo, unpaid, part-time
  project is never finishing. Days of work beats weeks.

The hosted application becomes the right answer if per-person logins are needed
(self-service absences), if the pool grows well past forty, or if the integrity
problem in §1.5 turns out to bite in practice rather than in theory.

### 1.5 What a spreadsheet costs us

**Storage enforces nothing.** Every invariant that a database would guarantee
with a constraint is, here, a convention. Sorting one column without the others
scrambles the ledger silently; a paste over a formula, a deleted row, or `12`
typed where `1.2` belongs are all accepted without complaint.

Four mitigations, in descending order of usefulness:

1. **`60_validate.gs` checks the invariants directly** — coverage, one post per
   person per day, nobody on guard two days running, names that exist, nobody rostered
   during an absence, escalation readiness, and every ledger price re-derived
   from the config version it claims. Run from the menu. This does not *prevent*
   a bad edit; it turns "silently wrong until September" into "flagged in
   seconds", which is the difference that matters.
2. **Data validation** on entry: posts as dropdowns, dates as dates, and names
   validated against the People tab, so a misspelling is rejected rather than
   quietly becoming a fourth colleague.
3. **Protected ranges** on Ledger, Escalations and Audit — warning rather than
   blocking, because a genuine correction has to stay possible.
4. **Revision history** for recovery once something is found.

**The Sheet must not be shared with the group.** Sharing is per-file, so a
viewer on the workbook can read individual `Absence` rows — which README §7.1
forbids. The board (§5) exists precisely so nobody needs view access.

**No test coverage above `30_scheduler.gs`.** Apps Script has no test runner, so
the I/O, setup, menu and board layers are verified by use. Hence keeping them
thin.

### 1.6 Civil dates, not timestamps

A slot belongs to a calendar day, and "Saturday" or "Christmas Day" is a
Europe/Brussels calendar fact. The pure modules work exclusively in ISO
`YYYY-MM-DD` strings and do all arithmetic through `Date.UTC`, so no timezone or
daylight-saving boundary can shift a date. `40_sheet.gs` is the only file that
converts to and from Sheet `Date` values, and it does so through
`Utilities.formatDate` in an explicit `Europe/Brussels` timezone. The script
manifest pins the same zone.

Getting this wrong prices multipliers against the wrong day type, and does it
inconsistently twice a year.

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
| **AuditEntry**    | What changed, when, by which Google account, under which period's operator                                                                          |

### 2.0 How the entities map to tabs

One tab per entity, with the header row as the schema. `HEADERS` in
`00_schema.gs` is authoritative — `50_setup.gs` creates the tabs from it and
`40_sheet.gs` reads columns by header name, so renaming a column in the Sheet
breaks the read rather than silently shifting data.

| Entity | Tab | Notes |
|---|---|---|
| Person | `People` | Plus an optional `Email`, used as the board's viewer allowlist (§5) |
| Absence | `Absences` | `Reduces availability` is a checkbox |
| Working fraction | `Workload` | One row per span of dates. Only needed when someone's hours change part-way through a period; the People tab's `Fraction` covers everything else |
| DayType | `Holidays` | Only holidays are stored; weekday, Friday, Saturday and Sunday are derived from the date |
| Slot | — | Never stored. Slots are generated from the date range, three per day |
| Assignment | `Roster` | What was planned |
| WorkedDuty | `Ledger` | What happened, and the only thing that earns points |
| Escalation | `Escalations` | Written by the drop-out flow |
| ScoringConfig | `Config` | `Version`, `Effective from`, `Key`, `Value` — one row per setting |
| Period | `Period` | A single row: start, end, operator |
| AuditEntry | `Audit` | Appended by `audit()` on every mutation |

### 2.1 Assignment versus WorkedDuty

The split matters enough to state on its own. `Assignment` is the plan;
`WorkedDuty` is what happened, and **only `WorkedDuty` earns points**.

On an undisturbed day the two mirror each other exactly and nobody ever looks at
the distinction. On a disturbed day it is the only thing keeping the ledger
honest: when the escalation chain shifts up (README §1.2), points and the
guard-free day after it both follow the worked post, not the rostered one
(README §2.4).

Collapsing them into one mutable row would make the roster unauditable the first
time somebody called in sick — and drop-outs are routine, not exceptional.

---

## 3. Scoring and configuration

### 3.1 Configuration is data, not code

Weights, multipliers, constraint parameters, the recalibration threshold
(`absence.minRecalibratingDays`) and the holiday calendar are all runtime data
with an effective-from date. **Never constants in source.** Two
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

### 3.4 Points are exact integers, never floats

Points look like decimals — 1.5, 4.5, 13.2 — and a fairness ledger cannot afford
floating-point drift. "Your balance is −0.00000000003" destroys confidence in a
tool whose entire job is being believably even.

So: **store multipliers and points as integer hundredths.** A multiplier of 1.5
is `150`; a base of 6 is `600`; their product divided by 100 is `900`, exactly
9.00 points. Addition and subtraction across a whole period stay exact, with no
dependency on a decimal library and no float anywhere in the arithmetic.

The one unavoidable division is `targetRate` (§3.2), which does not divide
evenly. Keep it out of the stored values: compute `expected(p)` as
`totalPoints × availableDays(p) / totalAvailableDays` — one division, performed
last, rounded only for display. `balance` is then exact up to that single
rounding, rather than accumulating error across several hundred duties.

---

## 4. The scheduler

Given the slots for a period and the current ledger, produce an `Assignment` for
every slot.

### 4.1 Constraint model

The six rules in README §5.1 are the **hard constraints** — coverage, escalation
readiness, one post per person per day, availability, no two days running, volume caps.
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
optima. Two reasons not to. The first is explainability: a solver's answer is
"the model says so", which is exactly the wrong thing to tell someone who thinks
they got a raw deal. The second is that no solver of that kind runs inside Apps
Script, so it would mean a service elsewhere and the end of the zero-hosting
property (§1.4).

Neither is likely to bite. Generation is **monthly, not annual** — around 90
slots against 40 people, which local search settles in well under a second, far
inside the Apps Script execution limit. Monthly is also the right product
behaviour, since absences are not known a year ahead.

**One structural property makes the search cheap.** Every slot in the window gets
filled, so the total points distributed is fixed before anything is assigned —
which means each person's *expected* share is a constant throughout the search.
The objective is therefore fully decomposable per person, and a swap only changes
the two people involved. Each move is O(1) rather than a full recomputation.

**The scheduler is a pure, isolated module**: slots and ledger in, assignments
and reasons out. No `SpreadsheetApp`, no I/O, and deterministic under a fixed
seed, so it is testable under Node (§1.2) and reproducible from its inputs. That
also means a future port to another language rewrites plumbing rather than
thinking.

Whichever is used, the requirement of README §5.2 stands: for any slot the system
must be able to name the candidates considered, their balances, and the
constraints that eliminated the rest.

### 4.4 The capacity floor

Worth writing down, because it bounds everything else. Nobody is on guard two
days running (README §5.1.5), so **every** post costs two person-days — the duty
itself plus the guard-free day after it, whichever post it was. Over any *D* days
that is `2D + 2D + 2D = 6D` person-days against a supply of `N × D`, so:

> **N ≥ 6.** Six is the absolute floor, and it is exactly saturated: two fixed
> sets of three, one on guard while the other recovers, alternating forever. Five
> is impossible under any arrangement — each person can cover at most every other
> day, giving `5 × D/2 = 2.5D` against a demand of `3D`.

Utilisation is therefore `6 / N`, tabulated in README §1.1. Allowing for leave and
illness the real survival floor is eight or nine; below about fifteen the rota
dominates everyone's life. **At the actual pool of roughly forty, utilisation is
about 15%** — each person holding around 27 posts a year, of which some 9 are
first calls.

**The arithmetic floor is not the algorithmic one.** Six is what the arithmetic
allows; greedy seeding needs nine to fill a month reliably. At saturation the only
valid roster is the exact alternating pattern, and seeding by largest deficit does
not reserve it — it fills the 1st and 2nd of a day and then finds nobody left for
the 3rd who is not already committed either side. Measured on a one-month window
with the volume caps off: 6, 7 and 8 fail, 9 and up succeed.

This is left as it is rather than fixed, deliberately. The failure is loud — a
`SchedulingError` naming the blocked slot (§4.1), never a partial roster — and it
sits at a pool size a quarter of the real one. Making the seed backtrack to reach
the true floor would add the one thing §4.3 trades everything else away to avoid:
a search whose answer cannot be explained as a sequence of moves. If the pool ever
approached nine the honest fix is more people, not a cleverer seed.

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

The `Absence` row is written with `Reduces availability` **unticked**. One day is
far under `absence.minRecalibratingDays`, so it keeps the dropper off that day's
roster without moving what they are expected to carry (README §3.1.1). Their
balance therefore falls against an unchanged target, which is the whole
correction; nothing else has to police it.

Ranking the shortlist for the vacated post uses the same deficit ordering as the
scheduler, filtered to available and escalation-ready people. It is a suggestion:
the operator records who actually took it.

**The shortlist excludes anyone on guard the day before or after, and gets that
for free.** `recordDropout` generates a one-day window and hands the rest of the
roster in as `priorAssignments`; `buildState` commits every out-of-window row into
`heldBy`, so `placementBlocker` rejects a candidate who holds a post either side.
No special case in the drop-out flow, and the reason a candidate is missing from
the shortlist is reported like any other blocker.

Nobody already in the chain can clash, because they were all rostered today and
the consecutive-day rule had already cleared their tomorrow (README §2.4). So an
escalation touches exactly one day of the roster — the vacant post — and never
cascades into the next.

---

## 5. Access, roles and audit

README §7.1 argued for two roles rather than forty accounts. Google's own sharing
gives us that, and better than shared passwords would have:

| | Who | How |
|---|---|---|
| **Edit** | the operator alone | The Sheet is shared with nobody else |
| **Read** | the pool | The Web App (`80_webapp.gs`), which the Sheet's data never reaches directly |

- **The Sheet is never shared with the group.** Sharing is per-file, so a viewer
  on the workbook could read individual `Absence` rows, which README §7.1
  forbids. The board is the group's only access path, and it emits availability
  as a derived day count and nothing more — enforced in `buildBoardData`, not in
  the template.
- **The board runs as the deploying account** (`executeAs: USER_DEPLOYING`), so
  it can read a Sheet its readers cannot open. That makes the allowlist the real
  access control, not a convenience.
- **The allowlist is the `Email` column on the People tab.** If any address is
  filled in, only those addresses may read the board; if the column is empty it
  degrades to "any signed-in Google account with the link". The empty case is the
  weaker default and SETUP.md asks for the emails.
- **Attribution is real.** `Session.getActiveUser()` gives the acting Google
  account, and Drive revision history records who changed which cell. This is
  strictly better than the shared-login design, which could only ever have
  recorded "the admin did it".
- **Every mutation writes to the `Audit` tab** — timestamp, acting account, the
  period's operator, action, detail — via `audit()` in `40_sheet.gs`. Revision
  history covers cell edits; the Audit tab covers what the *script* did, which
  revision history describes only as a bulk change.
- **`Period.operator` still matters.** It names who is accountable for the period
  even when several people have touched the account over the years.
- **Revocation is per-person.** Someone who leaves is removed from the People tab
  and loses board access with it. No password rotation, and no shared secret to
  leak — which removes an entire class of problem the hosted design had.

---

## 6. Open questions

Technical questions. The ones for the group are in README §9, which is where
the generation horizon now lives (§7.5).

- **Who owns the Google account in year three.** The tool lives in one Drive.
  The operator rotates annually and the maintainer may drift away; if the account
  is personal and lapses, the ledger goes with it. A dedicated account handed
  over each October is the current plan, and a department Workspace account is
  the better long-term answer. Unsolved, and not a technical problem.
- **How the swap record works.** README §9 wants swaps recorded rather than
  forbidden. Whether that is a ledger correction, a `Swap` tab, or an
  `Escalation` variant is undecided.
- **Partial-month publishing.** `publishMonth` skips dates already in the ledger,
  which is what protects settled drop-out days. It does not yet handle publishing
  a month that is only half over.
- **Recalculation scope.** §3.2 requires a logged recalculation when the config
  changes mid-period. Whether that reprices every duty in the period or only
  those after the effective-from date has fairness consequences, not just
  technical ones. Not yet implemented — today a config change leaves already
  published duties priced under the old version, which `60_validate.gs` reports
  as a mismatch only if the version numbers disagree.
- **No test coverage above the pure modules.** §1.5. Accepted, mitigated by
  keeping those layers thin.

---

## 7. Deferred work

Known and wanted, not built. Recorded here so it is not rediscovered.

### 7.1 The operator interface needs a rework

Every operator action is a chain of `ui.prompt()` dialogs: you type `2026-10` and
hope. No date picker, no list of names to choose from, no preview of a roster
before it is written. It works, and for an untrained operator it is worse than it
should be — which matters, because README §7 makes operability a hard
requirement rather than a nicety.

The shape of the fix is an Apps Script **HTML sidebar** in place of the prompt
chain: a month picker, a list of people to select from, and for generation a
preview of the resulting balance spread before anything is committed. Roughly a
few hundred lines, no new dependencies, and it removes almost all of the typing.

### 7.2 Overriding an assignment from the board

Today an override means typing over a cell on the Roster tab, which bypasses
every feasibility check — nothing stops you handing someone a post on their rest
day or during their leave. `60_validate.gs` catches it afterwards, if anybody
remembers to run it. README §5.2 wants overrides *supported*, not merely
possible, and free-form cell editing is not that.

Wanted: click a day in the calendar, get the same ranked shortlist the scheduler
uses — eligible people most-owed first, with each ineligible person's reason —
pick one, give a reason, and have it write the roster row and an audit entry.

**The security model is the hard part, and must not be skipped.** The Web App
runs as the deploying account (§5), so it can read a Sheet its readers cannot
open. The moment a callable mutation exists, *any viewer invoking it runs with
the owner's permissions*, and the email allowlist becomes the only thing between
a colleague and the ledger. Today that risk is exactly zero, because `doGet` is
the only entry point and nothing writes. Giving that up needs:

- the writable path confined to `showBoard()`, the menu dialog only the operator
  can open, with `doGet()` hardcoding read-only;
- every server-side mutation verifying the caller itself, never trusting a flag
  that arrived from the client;
- an audit entry for every write, as everywhere else.

Same reasoning applies to recording a drop-out or an absence by clicking a day,
which are the obvious follow-ons.

### 7.3 Validation on edit

`60_validate.gs` only runs when the operator chooses to run it. An `onEdit`
trigger would turn "silently wrong until September" into "flagged in seconds",
which is the whole mitigation §1.5 relies on. Cheap to add, and the reason the
checks were written as a pure function over the model rather than as a menu
action.

### 7.4 Recalculation when the scoring config changes

§3.2 requires an explicit, logged recalculation when weights change mid-period.
Not implemented: today a config change simply leaves already-published duties
priced under the old version. Whether a recalculation should reprice the whole
period or only duties after the effective-from date is a fairness decision, not
a technical one — see §6.

### 7.5 Generating further ahead

The policy question is README §9.1 and belongs to the group. **Three months, and
committed means committed, are now decided; whether that is a fixed quarter or a
rolling window is not.** This is what implementing either answer would take, plus
two rough edges the present behaviour has until then.

The two options need different amounts of the work below. **Fixed quarters need
only mechanism 1 and a quarter-sized generate action** — nothing is ever
regenerated, so there is no churn to control and no stability dial to tune. **A
rolling window needs all three.** That asymmetry is most of the argument for
fixed quarters, and worth weighing before the cadence is chosen rather than
after.

**Today:** `generateMonth` produces one month, for any month the operator types,
and nothing is frozen. Two consequences worth knowing:

- **Regenerating replaces.** A month can be regenerated at will, destroying
  manual overrides and changing dates people may already have planned around. It
  warns; nothing prevents it.
- **Months must be generated in order.** A month's balance is derived from the
  ledger plus whatever roster already exists, so generating March before January
  and February exist balances March as though those months never happened. Not
  enforced anywhere.

**What a longer horizon needs.** Three mechanisms, and the first is nearly free
and wanted either way:

1. **Commitment as a hard constraint, not an obstacle.** `Roster` gains a
   `Status` column (`provisional` / `committed`). Committed rows move from
   *to-be-generated* into `priorAssignments`, which the scheduler already treats
   as fixed. Generation then balances around them rather than refusing to run,
   so a window can be regenerated while keeping its committed subset intact.
2. **A stability term in the objective — rolling only.** Without it a rolling horizon is worse
   than useless: regenerate provisional months each cycle and everyone's dates
   shuffle, so people stop trusting anything uncommitted. A `weight.stability`
   penalty on moving an existing assignment makes regeneration change only what
   a new constraint forces or what buys a real fairness gain. It is a dial, and
   it trades away some of the late information it exists to exploit.
3. **One "generate the next block" action, not "generate month YYYY-MM".** Under
   either cadence this replaces the typed month: fixed quarters generate and
   commit the next quarter, a rolling window commits the nearest month and
   regenerates the tail. Either way it removes the date prompt and with it both
   rough edges above — no mistyped months and no out-of-order generation.

**Configuration, not constants** (§3.1): `horizon.committedMonths`,
`horizon.provisionalMonths`, `weight.stability`. A fixed quarter is
`committedMonths: 3, provisionalMonths: 0`, which is worth noting because it
means the cadence decision does not need a schema of its own — it is two numbers
on the Config tab.

**Generating three months at once is roughly 276 slots against the ~90 the search
was sized for** (§4.3). Expected to be fine and not yet measured; the parameter
to reach for if it is not is `search.iterations`, which is a config row.

Committing a month should write an audit entry — it is the moment the group can
be told, and the only record that a date became a promise.

### 7.6 Recording a swap

**Decided in principle, not designed.** Two people trading duties needs no
approval and no fairness guardrail — the group is content with an honour system
(README §9). But the *ledger* still has to see it, or points sit against whoever
was rostered rather than whoever turned up, and no later correction can find it.

So: no workflow, one obligation — tell the operator. The likely shape is a
`Record a swap…` menu action taking two names and a date, moving the
`WorkedDuty` rows and writing an audit entry, with the `Assignment` rows left
alone exactly as a drop-out leaves them (§4.5).

Two things to settle when it is picked up. Whether a swap is its own tab or just
a ledger correction with a reason (§6). And that swap volume is a function of the
horizon: the longer a published block is held committed, the more late-breaking
leave has nowhere to go but a swap — so this gets more load-bearing, not less,
once README §9.1 is answered.

### 7.7 The drop-out pattern review

**Wanted, not built. Operator-only, and that constraint is not negotiable.**

`Escalations` already stores every drop-out with its date and who dropped, so the
data is there; nothing reads it back. What is wanted is a per-person view — how
many drop-outs, on which day types, at which posts — so an operator can notice
that the same person has gone sick before four weekend firsts running.

The post and day type are not on the `Escalations` row and do not need to be:
both are derivable by joining `Date` back to `Roster`. So this is a read, not a
schema change.

Three rules it has to respect:

- **It never reaches the board.** README §7.1 keeps individual absence records
  away from the group, and this is the sharpest example of one — it names people
  and implies motive. It belongs in a Sheet tab or a menu dialog, and
  `buildBoardData` must never learn how to compute it (§5).
- **It is a report, not an enforcement.** The fairness consequence is already
  handled by the drop-out scoring nothing (README §2.4). This exists so a human
  can have a conversation, and it should carry no automatic effect.
- **No reasons, ever.** Counts, dates, posts and day types only. An absence
  reason does not go in the audit trail and does not go here either.
