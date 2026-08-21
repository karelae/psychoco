# Psychoco — Claude Code Instructions

Working instructions for Claude Code in this repository. Not part of the
application itself.

## Read first

- **[README.md](../README.md) is the specification** — the domain, the scoring
  policy, the fairness rules, and the operating model. It wins on any
  disagreement.
- **[TECHNICAL-README.md](../TECHNICAL-README.md) is the build reference** — data
  model, scheduling algorithm, configuration and audit mechanics. All technical
  detail belongs there and none of it in the README.
- This file carries working instructions only. Where something is written up in
  either document, this file points at it instead of restating it.
- **[rules/branch.md](rules/branch.md)** — branch naming, and what branches are
  cut from.
- **[rules/commit.md](rules/commit.md)** — commit message format.
- **[SETUP.md](../SETUP.md)** — how the Sheet and the script are deployed.

## What this service does

**Psychoco** distributes on-call shifts fairly across a rotating pool of
psychiatry co-assistants. Each shift is scored by how demanding it actually is
(level × day type), those scores accumulate in a per-person ledger, and a
scheduler generates rosters that balance accumulated burden against how much of
the period each person was actually available.

**Current state: first implementation.** The README is agreed. The scoring,
fairness and scheduling logic is written and tested; the Sheet layer, operator
menu and board are written but unexercised. No real period has been run.

## Stack: decided

**A Google Sheet with a bound Google Apps Script project.** The Sheet is the
datastore and the operator's interface; a Web App serves the group a read-only
board. No server, no database, no hosting. Full detail and the reasoning in
[TECHNICAL-README §1](../TECHNICAL-README.md), deployment steps in
[SETUP.md](../SETUP.md).

Three rules that follow from *why* it was chosen:

- **Keep the pure modules pure.** `00_schema.gs` through `30_scheduler.gs` must
  never reference `SpreadsheetApp`, `Utilities`, `Session` or any other Apps
  Script global. That is the only reason they can be tested (below), and Apps
  Script has no test runner of its own.
- **Keep the I/O layer thin.** `40_sheet.gs` and above cannot be covered by
  tests, so they should contain wiring and prompts, never logic worth verifying.
- **The Sheet enforces nothing.** Anything a database constraint would guarantee
  has to be checked in `60_validate.gs` instead, and every new invariant needs a
  check there.

## Domain invariants

Rules any implementation has to respect. Each is argued in the referenced
section, and that section is the authority — if this table disagrees with it, the
document wins. **R** = README.md, **T** = TECHNICAL-README.md.

| Invariant                                                                                       | Where          |
|-------------------------------------------------------------------------------------------------|----------------|
| Three posts (1st / 2nd / 3rd) are staffed every single day — 1,095 slots per period             | R §1.1         |
| On a drop-out the chain shifts up: 2nd → 1st, 3rd → 2nd, backfill at 3rd                        | R §1.2         |
| `points = base(level) × multiplier(day type)`                                                   | R §2           |
| Day-type multipliers never compound — the highest applicable one wins outright                  | R §2.2         |
| Weights and multipliers are placeholders until the group fixes them; never hard-code them       | R §2.2, T §3.1 |
| Points are credited for the post actually **worked**, never the post rostered                   | R §2.4         |
| A rest day follows a 1st only — 2nd and 3rd carry none, and it follows worked duty              | R §2.4, R §5.1 |
| Fairness is points per **available day**, not equal totals                                      | R §3           |
| Balances are derived, never stored as running totals                                            | T §3.3         |
| Points and multipliers are integer hundredths — never floating point                            | T §3.4         |
| Slot dates are civil dates resolved in Europe/Brussels, never timestamps                        | T §1.6         |
| The period runs 1 Oct – 30 Sep; balances reset to zero and never carry over                     | R §4           |
| Coverage is a hard constraint and must fail loudly, never emit a partial roster                 | R §5.1, T §4.1 |
| Balance is optimised continuously across the period, not at its end                             | R §4, T §4.2   |
| Every assignment must be explainable, and every one overridable by hand                         | R §5.2, T §4.3 |
| `Assignment` (planned) and `WorkedDuty` (actual) stay separate records                          | T §2.1         |
| Every priced duty references the scoring-config version it was priced under                     | T §3.2         |
| One editor (the operator), everyone else read-only; every mutation writes an audit entry        | R §7.1, T §5   |
| The viewer must never read individual absence records — only a derived day count                | R §7.1, T §5   |
| Operable by an untrained person who changes annually — no config files or CLI for routine tasks | R §7           |

## Build & test

```bash
node --test test/                 # everything
npx @google/clasp push            # upload to the bound script
npx @google/clasp pull            # if someone edited in the browser first
npx @google/clasp deploy          # publish a new Web App version
```

There is no build step and no dependency install — `test/harness.mjs` loads the
`.gs` files into a `vm` context using only Node built-ins.

### Test output filtering

`node --test` is already terse: it prints one line per passing test and full
detail only for failures. Two-phase pattern:

```bash
node --test test/                             # phase 1: which test fails
node --test --test-name-pattern 'balance' test/   # phase 2: narrow to it
```

Do not pipe the whole suite through a formatter that expands passing output.

## Architecture

```
apps-script/
  00_schema.gs      constants, civil-date and fixed-point helpers   — pure
  10_scoring.gs     points = base x multiplier                      — pure
  20_fairness.gs    availability, expected share, balance           — pure
  30_scheduler.gs   constraints, greedy seed, local search          — pure
  40_sheet.gs       the only file that touches SpreadsheetApp
  50_setup.gs       builds the workbook from HEADERS
  60_validate.gs    invariant checks
  70_menu.gs        the operator's actions
  80_webapp.gs      the read-only board + access control
  board.html        the board's markup, styles and rendering
test/               Node tests for 00-30
```

**Rules:**
- Apps Script concatenates every `.gs` file into one global scope. The numeric
  prefixes carry the dependency direction — a file may use anything defined
  below its number, never above it.
- New logic defaults to a pure module. If it needs the Sheet, split it: the
  decision goes in a pure module, the reading and writing in `40_sheet.gs`.
- `HEADERS` in `00_schema.gs` is the schema. Columns are read by header name, so
  changing one there means changing the Sheet too.

## Code style

- Plain ES5-style JavaScript in the `.gs` files: `var`, `function`, no modules,
  no `import`. Apps Script runs V8 so modern syntax works, but the files share
  one global scope and the test harness evaluates them as scripts — keep them
  script-shaped. Test files are ESM and may use anything Node 20 supports.
- **Never use floating point for points or balances.** Multipliers, bases and
  points are integer hundredths (TECHNICAL-README §3.4). The one deliberate
  exception is the scheduler's search objective, which is a heuristic score and
  is never persisted.
- Civil dates only: ISO `YYYY-MM-DD` strings in the pure modules, all arithmetic
  through `Date.UTC`. Conversion to and from Sheet `Date` values happens in
  `40_sheet.gs` alone, in `Europe/Brussels` (TECHNICAL-README §1.6).
- Every mutation calls `audit()`. With one editing account, that tab plus Drive
  revision history is the whole record of what happened.
- Errors the operator will see should say what to do next, not just what broke.

## Testing patterns

- Node's runner plus the project convention: a top-level `test('area', ...)` with
  subtests named `should_<verb>_when_<condition>` through `await t.test(...)`.
- Test against the documents. The README §3.3 worked example is asserted number
  for number in `test/fairness.test.mjs`; that is the model to follow for
  anything the README states as policy.
- Values that cross the `vm` boundary carry the context's prototypes, so strict
  `deepEqual` rejects structurally identical objects. Wrap them in `plain()` from
  the harness.
- The scheduler is deterministic under a fixed seed. Assert on constraints and
  invariants rather than on specific names wherever possible — a golden roster
  is brittle, "nobody works the day after a 1st" is not.
- Prove a constraint, not the heuristic that usually hides it. Testing that 2nd
  and 3rd may fall on consecutive days needs a saturated four-person pool,
  because a large pool spreads them apart for unrelated reasons.

## Logging

- No `console.log` in committed code. Operator-facing output goes through
  `SpreadsheetApp.getUi()`; anything worth keeping goes to the `Audit` tab.
- **No personal data beyond a name in the audit trail**, and never an absence
  reason. README §7.1 keeps absence detail away from the group, and the audit
  trail is not an exception.

## Config

- Scoring weights, multipliers, caps, search parameters and the holiday calendar
  are **rows on the Config and Holidays tabs**, edited by the operator — never
  constants in the code. `DEFAULT_CONFIG` in `00_schema.gs` seeds a new workbook
  with placeholders and is not a source of truth afterwards.
- Config is versioned. Every ledger row records the version it was priced under,
  and `60_validate.gs` re-derives the price to check it (TECHNICAL-README §3.2).

## Pre-commit checklist

- On a branch, never `main` (rules/commit.md)
- Commit message is a single short line, no body (rules/commit.md)
- `node --test test/` passes
- New logic went in a pure module, not in the Sheet layer
- Any new invariant has a check in `60_validate.gs`
- No scoring weights or multipliers hard-coded as constants
- No floating point anywhere near points or balances
- Design changes documented: policy and domain in README, technical detail in
  TECHNICAL-README — never technical detail in the README
