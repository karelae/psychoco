import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPure, defaultConfig, pool, emptyAbsences, plain } from './harness.mjs';

const psy = loadPure();

const PERIOD = { start: '2026-10-01', end: '2027-09-30' };
const HOLIDAYS = { '2026-11-11': 'public', '2026-12-25': 'protected' };

function input(people, overrides = {}) {
  return {
    dates: psy.monthDates(2026, 10),
    people,
    absencesByName: emptyAbsences(people),
    holidayKindByDate: HOLIDAYS,
    config: defaultConfig(psy, { search: { iterations: 4000 } }),
    priorDuties: [],
    priorAssignments: [],
    period: PERIOD,
    ...overrides
  };
}

function heldByPerson(assignments) {
  const held = {};
  for (const a of assignments) {
    if (!held[a.name]) held[a.name] = {};
    held[a.name][a.date] = a.post;
  }
  return held;
}

test('coverage', async (t) => {
  const result = plain(psy.generateRoster(input(pool(20))));

  await t.test('should_fill_three_posts_on_every_day_when_pool_is_ample', () => {
    assert.equal(result.assignments.length, 93); // 31 days x 3 posts
    for (const a of result.assignments) {
      assert.ok(a.name, 'unfilled slot: ' + a.post + ' on ' + a.date);
    }
  });

  await t.test('should_fill_each_post_exactly_once_per_day', () => {
    const seen = new Set();
    for (const a of result.assignments) {
      const key = a.date + '|' + a.post;
      assert.ok(!seen.has(key), 'duplicate slot ' + key);
      seen.add(key);
    }
    assert.equal(seen.size, 93);
  });

  await t.test('should_never_give_one_person_two_posts_on_the_same_day', () => {
    const perDay = {};
    for (const a of result.assignments) {
      if (!perDay[a.date]) perDay[a.date] = new Set();
      assert.ok(!perDay[a.date].has(a.name), a.name + ' twice on ' + a.date);
      perDay[a.date].add(a.name);
    }
  });

  // README §5.1.5 — nobody is on guard two days running, whichever post it is.
  await t.test('should_never_give_anyone_posts_on_consecutive_days', () => {
    const held = heldByPerson(result.assignments);
    for (const name of Object.keys(held)) {
      for (const date of Object.keys(held[name])) {
        const next = psy.isoAddDays(date, 1);
        assert.ok(
          !held[name][next],
          name + ' held ' + held[name][date] + ' on ' + date + ' and ' +
          held[name][next] + ' on ' + next
        );
      }
    }
  });

  // A 20-person pool honours the rule for unrelated reasons — the spacing
  // objective spreads posts apart anyway — so it proves nothing about the
  // constraint. Force the issue with a pool close to saturation, every soft
  // objective and volume cap switched off, so only the hard rule is left to
  // stop consecutive days (see .claude/CLAUDE.md on proving constraints).
  await t.test('should_never_give_anyone_consecutive_days_when_the_pool_is_saturated', () => {
    const cfg = defaultConfig(psy, {
      search: { iterations: 0 },
      caps: { shiftsPerWeek: 0, shiftsPerMonth: 0, minWeekendGapDays: 0 },
      weights: { categoryParity: 0, spacing: 0 }
    });
    const saturated = plain(psy.generateRoster(input(pool(9), { config: cfg })));
    const held = heldByPerson(saturated.assignments);

    let busiest = 0;
    for (const name of Object.keys(held)) {
      const dates = Object.keys(held[name]);
      busiest = Math.max(busiest, dates.length);
      for (const date of dates) {
        assert.ok(
          !held[name][psy.isoAddDays(date, 1)],
          name + ' is on guard on ' + date + ' and the day after'
        );
      }
    }
    // Guard against the test passing because nobody worked much: at N=9 over 31
    // days somebody must be carrying close to every other day.
    assert.ok(busiest >= 10, 'pool is not saturated enough to prove anything (busiest = ' + busiest + ')');
  });
});

test('determinism', async (t) => {
  await t.test('should_produce_an_identical_roster_when_the_seed_is_unchanged', () => {
    const people = pool(20);
    const a = plain(psy.generateRoster(input(people)));
    const b = plain(psy.generateRoster(input(people)));
    assert.deepEqual(
      a.assignments.map((x) => x.name),
      b.assignments.map((x) => x.name)
    );
  });

  await t.test('should_produce_a_different_roster_when_the_seed_changes', () => {
    const people = pool(20);
    const a = plain(psy.generateRoster(input(people)));
    const b = plain(psy.generateRoster(input(people, {
      config: defaultConfig(psy, { search: { iterations: 4000, seed: 99 } })
    })));
    assert.notDeepEqual(
      a.assignments.map((x) => x.name),
      b.assignments.map((x) => x.name)
    );
  });
});

test('fairness of the result', async (t) => {
  await t.test('should_not_make_the_objective_worse_than_the_greedy_seed', () => {
    const result = psy.generateRoster(input(pool(20)));
    assert.ok(
      result.objectiveAfter <= result.objectiveBefore,
      'local search worsened the objective: ' + result.objectiveBefore + ' -> ' + result.objectiveAfter
    );
  });

  await t.test('should_spread_points_evenly_when_everyone_is_equally_available', () => {
    const people = pool(20);
    const result = plain(psy.generateRoster(input(people)));

    const pointsByName = {};
    for (const p of people) pointsByName[p.name] = 0;
    for (const a of result.assignments) pointsByName[a.name] += a.pointsH;

    const totals = Object.values(pointsByName);
    const mean = totals.reduce((x, y) => x + y, 0) / totals.length;
    const worst = Math.max(...totals.map((v) => Math.abs(v - mean)));

    // Everyone equally available, so nobody should be more than one heavy
    // shift away from the mean over a single month.
    assert.ok(
      worst <= 1320,
      'worst deviation was ' + psy.fromHundredths(worst) + ' points from a mean of ' +
        psy.fromHundredths(mean)
    );
  });

  await t.test('should_give_fewer_posts_when_a_person_is_only_half_available', () => {
    const people = pool(20);
    people[0].fractionH = 50;
    const result = plain(psy.generateRoster(input(people)));

    const counts = {};
    for (const a of result.assignments) counts[a.name] = (counts[a.name] || 0) + 1;
    const others = people.slice(1).map((p) => counts[p.name] || 0);
    const meanOther = others.reduce((x, y) => x + y, 0) / others.length;

    assert.ok(
      (counts[people[0].name] || 0) < meanOther,
      'half-time person got ' + counts[people[0].name] + ' posts vs a mean of ' + meanOther
    );
  });
});

test('constraints', async (t) => {
  await t.test('should_never_roster_someone_during_a_recorded_absence', () => {
    const people = pool(20);
    const absences = emptyAbsences(people);
    absences[people[0].name] = [{ from: '2026-10-05', to: '2026-10-20', reduces: true }];
    const result = plain(psy.generateRoster(input(people, { absencesByName: absences })));

    for (const a of result.assignments) {
      if (a.name !== people[0].name) continue;
      assert.ok(
        a.date < '2026-10-05' || a.date > '2026-10-20',
        people[0].name + ' rostered on ' + a.date + ' during absence'
      );
    }
  });

  await t.test('should_only_use_posts_a_person_is_cleared_for', () => {
    const people = pool(20);
    people[0].restrictions = ['2nd']; // may hold 1st only
    const result = plain(psy.generateRoster(input(people)));

    for (const a of result.assignments) {
      if (a.name === people[0].name) assert.equal(a.post, '1st');
    }
  });

  await t.test('should_respect_the_monthly_cap', () => {
    const people = pool(20);
    const cfg = defaultConfig(psy, { search: { iterations: 4000 }, caps: { shiftsPerMonth: 6 } });
    const result = plain(psy.generateRoster(input(people, { config: cfg })));

    const counts = {};
    for (const a of result.assignments) counts[a.name] = (counts[a.name] || 0) + 1;
    for (const name of Object.keys(counts)) {
      assert.ok(counts[name] <= 6, name + ' got ' + counts[name] + ' posts, cap was 6');
    }
  });

  await t.test('should_not_roster_someone_before_they_arrive', () => {
    const people = pool(20);
    people[0].arrival = '2026-10-15';
    const result = plain(psy.generateRoster(input(people)));
    for (const a of result.assignments) {
      if (a.name === people[0].name) assert.ok(a.date >= '2026-10-15');
    }
  });
});

// TECHNICAL-README §4.1: coverage is the constraint that must fail loudly
// rather than silently emit an incomplete roster.
test('failing loudly', async (t) => {
  await t.test('should_throw_naming_the_blocked_slot_when_pool_is_too_small', () => {
    // Three people cannot staff three posts a day: whoever holds 1st today is
    // resting tomorrow, leaving two for three posts (TECHNICAL-README §4.4).
    assert.throws(
      () => psy.generateRoster(input(pool(3))),
      (err) => {
        assert.equal(err.name, 'SchedulingError');
        assert.match(err.message, /Cannot cover (1st|2nd|3rd) on 2026-10-\d\d/);
        assert.ok(err.detail.date, 'error should name the date');
        assert.ok(Object.keys(err.detail.blockers).length === 3, 'error should explain every person');
        return true;
      }
    );
  });

  await t.test('should_throw_when_the_pool_is_under_the_capacity_floor', () => {
    // Every post now blocks the following day, so the three posts cost 6D
    // person-days against a supply of N x D: the floor is 6, and 5 cannot work
    // under any arrangement (TECHNICAL-README §4.4).
    const cfg = defaultConfig(psy, {
      search: { iterations: 500 },
      caps: { shiftsPerWeek: 0, shiftsPerMonth: 0, minWeekendGapDays: 0 }
    });
    assert.throws(() => psy.generateRoster(input(pool(5), { config: cfg })),
      (err) => err.name === 'SchedulingError');
  });

  await t.test('should_fill_a_month_when_the_pool_clears_the_greedy_seed', () => {
    // The floor of 6 is what arithmetic allows, not what greedy seeding finds:
    // saturation at N=6 needs the exact alternating pattern and the seed does
    // not reserve it. Nine is where a month becomes reliably fillable, and the
    // gap is documented in TECHNICAL-README §4.4 rather than worked around,
    // because the real pool is forty.
    const cfg = defaultConfig(psy, {
      search: { iterations: 500 },
      caps: { shiftsPerWeek: 0, shiftsPerMonth: 0, minWeekendGapDays: 0 }
    });
    const result = plain(psy.generateRoster(input(pool(9), { config: cfg })));
    assert.equal(result.assignments.length, 93);
    for (const a of result.assignments) assert.ok(a.name);
  });
});

test('explainability', async (t) => {
  // README §5.2: every assignment must be answerable with "why this person?".
  await t.test('should_name_eligible_and_blocked_candidates_when_explaining_a_slot', () => {
    const people = pool(20);
    const base = input(people);
    const roster = psy.generateRoster(base);
    const withRoster = { ...base, priorAssignments: plain(roster.assignments) };

    const explained = plain(psy.explainAssignment(withRoster, '2026-10-15', '1st'));

    assert.equal(explained.date, '2026-10-15');
    assert.equal(explained.post, '1st');
    assert.ok(explained.price.text.includes('1st on 2026-10-15'));
    assert.ok(explained.eligible.length + explained.blocked.length === 20);
    assert.ok(explained.blocked.length > 0, 'somebody should have been ruled out');
    for (const b of explained.blocked) {
      assert.ok(b.reason && b.reason.length > 0, b.name + ' blocked without a reason');
    }
  });
});

/**
 * Regression: a late joiner must not have a whole period's deficit dumped into
 * their first month. README §4 forbids loading someone up early — and before
 * the fix, generation measured expected share against period-end availability,
 * so a person who arrived on day one of the window looked owed a year of duty.
 */
test('late joiners', async (t) => {
  await t.test('should_not_front_load_a_whole_period_onto_someone_who_just_arrived', () => {
    const people = pool(20);
    people[0].arrival = '2026-10-01'; // window start — nothing carried yet

    // Two months of duty already carried by everyone except the newcomer.
    const priorDuties = [];
    for (const iso of psy.monthDates(2026, 8).concat(psy.monthDates(2026, 9))) {
      people.slice(1).forEach((p, i) => {
        if (i % 4 !== 0) return;
        priorDuties.push({ date: iso, post: '3rd', name: p.name, pointsH: 100 });
      });
    }

    const result = plain(psy.generateRoster(input(people, {
      priorDuties,
      period: { start: '2026-08-01', end: '2027-09-30' }
    })));

    const counts = {};
    for (const a of result.assignments) counts[a.name] = (counts[a.name] || 0) + 1;
    const newcomer = counts[people[0].name] || 0;
    const mean = result.assignments.length / people.length;

    assert.ok(
      newcomer <= mean * 2,
      'newcomer took ' + newcomer + ' posts against a mean of ' + mean.toFixed(1)
    );
  });
});
