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

## What this service does

**Psychoco** distributes on-call shifts fairly across a rotating pool of
psychiatry co-assistants. Each shift is scored by how demanding it actually is
(level × day type), those scores accumulate in a per-person ledger, and a
scheduler generates rosters that balance accumulated burden against how much of
the period each person was actually available.

**Current state: design phase.** The README is agreed. Nothing is implemented.

## Stack: undecided

Nothing is chosen — not language, framework, datastore, or hosting (README §10,
"Where it runs"). **Do not assume one.** In particular, do not infer a stack from
conventions in this file, from tooling on this machine, or from unrelated
projects alongside it. Choosing it is an explicit decision to make with the
maintainer, and the TBD sections below get filled in afterwards.

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
| The period runs 1 Oct – 30 Sep; balances reset to zero and never carry over                     | R §4           |
| Coverage is a hard constraint and must fail loudly, never emit a partial roster                 | R §5.1, T §4.1 |
| Balance is optimised continuously across the period, not at its end                             | R §4, T §4.2   |
| Every assignment must be explainable, and every one overridable by hand                         | R §5.2, T §4.3 |
| `Assignment` (planned) and `WorkedDuty` (actual) stay separate records                          | T §2.1         |
| Every priced duty references the scoring-config version it was priced under                     | T §3.2         |
| Two shared logins (viewer, admin); every mutation writes an audit entry with an actor           | R §7.1, T §5   |
| The viewer must never read individual absence records — only a derived day count                | R §7.1, T §5   |
| Operable by an untrained person who changes annually — no config files or CLI for routine tasks | R §7           |

## Build & test

_TBD — depends on the stack._

### Test output filtering

Worth keeping whatever the stack turns out to be: run tests filtered to failures
and summaries first to keep token use down, then re-run unfiltered on the
specific failure for full diagnostics. Concrete commands go here once there is a
stack to write them for.

## Architecture

_TBD — nothing built yet._

## Code style

_TBD — set once the language is chosen._

## Testing patterns

_TBD. One convention to carry over regardless of stack: name tests
`should_<verb>_when_<condition>`._

## Logging

_TBD._

## Config

_TBD. One rule the design already fixes: scoring weights, multipliers, constraint
parameters, and the holiday calendar are runtime data, editable in the UI by the
operator — never constants in source (README §7, TECHNICAL-README §3.1)._

## Pre-commit checklist

- On a branch, never `main` (rules/commit.md)
- Commit message is a single short line, no body (rules/commit.md)
- No scoring weights or multipliers hard-coded as constants
- Design changes documented: policy and domain in README, technical detail in
  TECHNICAL-README — never technical detail in the README
