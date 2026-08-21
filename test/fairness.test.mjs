import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPure, plain } from './harness.mjs';

const psy = loadPure();

const PERIOD = { start: '2026-10-01', end: '2026-12-31' }; // 92 days

function person(name, extra = {}) {
  return {
    name,
    arrival: PERIOD.start,
    departure: null,
    fractionH: 100,
    restrictions: [],
    ...extra
  };
}

test('availability', async (t) => {
  await t.test('should_count_every_day_when_present_throughout_and_never_absent', () => {
    assert.equal(psy.availableDayHundredths(person('A'), [], PERIOD.start, PERIOD.end), 9200);
  });

  await t.test('should_count_from_arrival_when_joining_mid_period', () => {
    const p = person('B', { arrival: '2026-11-01' });
    assert.equal(psy.availableDayHundredths(p, [], PERIOD.start, PERIOD.end), 6100);
  });

  await t.test('should_stop_at_departure_when_leaving_mid_period', () => {
    const p = person('C', { departure: '2026-10-31' });
    assert.equal(psy.availableDayHundredths(p, [], PERIOD.start, PERIOD.end), 3100);
  });

  await t.test('should_subtract_absence_when_it_reduces_availability', () => {
    const absences = [{ from: '2026-11-01', to: '2026-11-14', reduces: true }];
    assert.equal(psy.availableDayHundredths(person('D'), absences, PERIOD.start, PERIOD.end), 7800);
  });

  // README §3.1 — a day off in lieu should not lower what you are expected to carry.
  await t.test('should_ignore_absence_when_it_does_not_reduce_availability', () => {
    const absences = [{ from: '2026-11-01', to: '2026-11-14', reduces: false }];
    assert.equal(psy.availableDayHundredths(person('E'), absences, PERIOD.start, PERIOD.end), 9200);
  });

  await t.test('should_not_double_count_when_absences_overlap', () => {
    const absences = [
      { from: '2026-11-01', to: '2026-11-10', reduces: true },
      { from: '2026-11-05', to: '2026-11-14', reduces: true }
    ];
    assert.equal(psy.availableDayHundredths(person('F'), absences, PERIOD.start, PERIOD.end), 7800);
  });

  await t.test('should_clip_absence_when_it_extends_beyond_the_period', () => {
    const absences = [{ from: '2026-09-01', to: '2026-10-05', reduces: true }];
    // Only 1-5 October fall inside the period.
    assert.equal(psy.availableDayHundredths(person('G'), absences, PERIOD.start, PERIOD.end), 8700);
  });

  await t.test('should_halve_available_days_when_working_fraction_is_half', () => {
    const p = person('H', { fractionH: 50 });
    assert.equal(psy.availableDayHundredths(p, [], PERIOD.start, PERIOD.end), 4600);
  });

  await t.test('should_return_zero_when_person_does_not_overlap_the_period', () => {
    const p = person('I', { arrival: '2027-01-01' });
    assert.equal(psy.availableDayHundredths(p, [], PERIOD.start, PERIOD.end), 0);
  });
});

/**
 * The worked example from README §3.3, asserted number for number.
 *
 * This is the test that matters most: it checks the implementation against the
 * document the group agreed to, not against itself.
 */
test('the README worked example', async (t) => {
  const people = [
    person('A'),
    person('B', { arrival: '2026-11-01' }),
    person('C')
  ];
  const absencesByName = {
    A: [],
    B: [],
    C: [{ from: '2026-11-01', to: '2026-11-14', reduces: true }]
  };
  const duties = [
    { name: 'A', pointsH: 20000 },
    { name: 'B', pointsH: 10000 },
    { name: 'C', pointsH: 16200 }
  ];

  const board = psy.computeBalances(people, absencesByName, duties, PERIOD.start, PERIOD.end);
  const byName = {};
  for (const row of plain(board.rows)) byName[row.name] = row;

  await t.test('should_total_231_available_days_when_pool_is_A_B_and_C', () => {
    assert.equal(board.totalAvailH, 23100);
    assert.equal(byName.A.availH, 9200);
    assert.equal(byName.B.availH, 6100);
    assert.equal(byName.C.availH, 7800);
  });

  await t.test('should_derive_a_target_rate_of_2_points_per_available_day', () => {
    assert.equal(board.totalPointsH, 46200);
    assert.equal(board.targetRateH, 200);
  });

  await t.test('should_expect_184_122_and_156_points_when_scaled_by_availability', () => {
    assert.equal(byName.A.expectedH, 18400);
    assert.equal(byName.B.expectedH, 12200);
    assert.equal(byName.C.expectedH, 15600);
  });

  await t.test('should_report_balances_of_plus16_minus22_and_plus6', () => {
    assert.equal(byName.A.balanceH, 1600);
    assert.equal(byName.B.balanceH, -2200);
    assert.equal(byName.C.balanceH, 600);
  });

  // The point of the whole example: B has the lowest raw total and is still owed.
  await t.test('should_rank_B_first_when_B_has_the_lowest_total_but_is_most_owed', () => {
    assert.equal(board.rows[0].name, 'B');
    assert.ok(byName.B.pointsH < byName.A.pointsH, 'B carried fewer points than A');
    assert.ok(byName.B.balanceH < byName.A.balanceH, 'yet B is the one owed a shift');
  });
});

test('balances', async (t) => {
  await t.test('should_sum_to_zero_when_every_person_is_accounted_for', () => {
    const people = [person('A'), person('B', { arrival: '2026-11-01' }), person('C', { fractionH: 50 })];
    const duties = [
      { name: 'A', pointsH: 12345 },
      { name: 'B', pointsH: 6789 },
      { name: 'C', pointsH: 4321 }
    ];
    const board = psy.computeBalances(people, { A: [], B: [], C: [] }, duties, PERIOD.start, PERIOD.end);
    const sum = board.rows.reduce((acc, r) => acc + r.balanceH, 0);
    // Balances are a zero-sum redistribution, give or take integer rounding.
    assert.ok(Math.abs(sum) <= board.rows.length, 'sum of balances was ' + sum);
  });

  await t.test('should_give_everyone_a_zero_balance_when_load_matches_availability', () => {
    const people = [person('A'), person('B')];
    const duties = [{ name: 'A', pointsH: 5000 }, { name: 'B', pointsH: 5000 }];
    const board = psy.computeBalances(people, { A: [], B: [] }, duties, PERIOD.start, PERIOD.end);
    for (const row of board.rows) assert.equal(row.balanceH, 0);
  });

  await t.test('should_expect_half_as_much_when_someone_works_half_time', () => {
    const people = [person('A'), person('B', { fractionH: 50 })];
    const duties = [{ name: 'A', pointsH: 3000 }, { name: 'B', pointsH: 0 }];
    const board = psy.computeBalances(people, { A: [], B: [] }, duties, PERIOD.start, PERIOD.end);
    const byName = {};
    for (const row of plain(board.rows)) byName[row.name] = row;
    assert.equal(byName.A.expectedH, 2000);
    assert.equal(byName.B.expectedH, 1000);
  });

  await t.test('should_not_divide_by_zero_when_nobody_is_available', () => {
    const people = [person('A', { arrival: '2027-06-01' })];
    const board = psy.computeBalances(people, { A: [] }, [], PERIOD.start, PERIOD.end);
    assert.equal(board.targetRateH, 0);
    assert.equal(board.rows[0].expectedH, 0);
  });
});

/**
 * Regression: availability must be measured as of a point in time, not against
 * the whole period. Measuring against the period end makes anybody who leaves
 * mid-period look overloaded, because their expected share is scaled by months
 * they have not worked yet.
 */
test('availability as of a date', async (t) => {
  const FULL = { start: '2026-10-01', end: '2027-09-30' };
  const staying = person('Stays', { arrival: FULL.start });
  const leaving = person('Leaves', { arrival: FULL.start, departure: '2027-02-28' });
  const duties = [
    { name: 'Stays', pointsH: 3000 },
    { name: 'Leaves', pointsH: 3000 }
  ];
  const absences = { Stays: [], Leaves: [] };

  await t.test('should_expect_the_same_when_both_worked_the_whole_window', () => {
    // As of 31 December both have been present for all 92 days, so having
    // carried the same points means both are level.
    const board = psy.computeBalances([staying, leaving], absences, duties, FULL.start, '2026-12-31');
    const byName = {};
    for (const r of plain(board.rows)) byName[r.name] = r;
    assert.equal(byName.Stays.availH, byName.Leaves.availH);
    assert.equal(byName.Leaves.balanceH, 0);
  });

  await t.test('should_overstate_the_leavers_balance_when_measured_at_period_end', () => {
    // The bug this guards against: at period end the leaver's availability is
    // smaller, so identical work reads as a surplus.
    const board = psy.computeBalances([staying, leaving], absences, duties, FULL.start, FULL.end);
    const byName = {};
    for (const r of plain(board.rows)) byName[r.name] = r;
    assert.ok(byName.Leaves.availH < byName.Stays.availH);
    assert.ok(byName.Leaves.balanceH > 0, 'this is why the board must pass an as-of date');
  });
});

test('people who can hold no post', async (t) => {
  // A restriction on 1st rules out every post, so they are not on the rota and
  // must not draw an expected share — otherwise they accrue a deficit nobody
  // can repay while lowering everyone else's fair share.
  await t.test('should_have_zero_availability_when_cleared_for_no_post', () => {
    const blocked = person('Blocked', { restrictions: ['1st'] });
    assert.equal(psy.canHoldAnyPost(blocked), false);
    assert.equal(psy.availableDayHundredths(blocked, [], PERIOD.start, PERIOD.end), 0);
  });

  await t.test('should_not_change_other_peoples_expected_share_when_present', () => {
    const a = person('A');
    const b = person('B');
    const blocked = person('Blocked', { restrictions: ['1st'] });
    const duties = [{ name: 'A', pointsH: 1000 }, { name: 'B', pointsH: 1000 }];

    const without = psy.computeBalances([a, b], { A: [], B: [] }, duties, PERIOD.start, PERIOD.end);
    const withBlocked = psy.computeBalances(
      [a, b, blocked], { A: [], B: [], Blocked: [] }, duties, PERIOD.start, PERIOD.end
    );

    assert.equal(withBlocked.totalAvailH, without.totalAvailH);
    for (const row of plain(withBlocked.rows)) {
      if (row.name === 'Blocked') { assert.equal(row.expectedH, 0); continue; }
      const before = plain(without.rows).find((r) => r.name === row.name);
      assert.equal(row.expectedH, before.expectedH, row.name + "'s share must not move");
    }
  });
});

/**
 * A working fraction belongs to a person *on a date*, not to a person.
 *
 * Somebody who works full time until February and half time afterwards was
 * genuinely fully available in October. Applying their current fraction to the
 * whole period would erase availability they actually had, inflate their balance,
 * and under-load them for the rest of the year to compensate for something that
 * never happened.
 */
test('working fraction over time', async (t) => {
  const YEAR = { start: '2026-10-01', end: '2027-09-30' };
  const p = person('Anna', { arrival: YEAR.start });
  const goesHalfTime = [{ from: '2027-02-01', to: '2027-09-30', fractionH: 50 }];

  await t.test('should_use_the_span_when_the_date_is_covered', () => {
    assert.equal(psy.fractionHOn(p, goesHalfTime, '2027-03-15'), 50);
  });

  await t.test('should_fall_back_to_the_person_default_when_no_span_covers_the_date', () => {
    assert.equal(psy.fractionHOn(p, goesHalfTime, '2026-11-15'), 100);
    assert.equal(psy.fractionHOn(p, [], '2026-11-15'), 100);
  });

  await t.test('should_let_a_later_span_win_when_two_overlap', () => {
    const corrected = goesHalfTime.concat([{ from: '2027-03-01', to: '2027-03-31', fractionH: 80 }]);
    assert.equal(psy.fractionHOn(p, corrected, '2027-03-15'), 80);
    assert.equal(psy.fractionHOn(p, corrected, '2027-04-15'), 50);
  });

  await t.test('should_count_123_full_days_and_242_half_days_when_going_half_time_in_february', () => {
    const availH = psy.availableDayHundredths(p, [], YEAR.start, YEAR.end, goesHalfTime);
    assert.equal(availH, 123 * 100 + 242 * 50);
  });

  await t.test('should_not_retroactively_erase_availability_already_worked', () => {
    const correct = psy.availableDayHundredths(p, [], YEAR.start, YEAR.end, goesHalfTime);
    // The bug: treating the new fraction as if it had always applied.
    const naive = psy.availableDayHundredths(
      { ...p, fractionH: 50 }, [], YEAR.start, YEAR.end
    );
    assert.equal(naive, 365 * 50);
    assert.ok(correct > naive, 'the naive reading loses availability that was genuinely there');
    assert.equal(correct - naive, 6150); // 61.5 days wrongly written off
  });

  await t.test('should_keep_earned_points_untouched_when_the_fraction_changes', () => {
    // Points are historical facts; only the expectation moves (README §2.4).
    const other = person('Bo', { arrival: YEAR.start });
    const duties = [{ name: 'Anna', pointsH: 3000 }, { name: 'Bo', pointsH: 3000 }];
    const absences = { Anna: [], Bo: [] };

    const before = psy.computeBalances([p, other], absences, duties, YEAR.start, YEAR.end);
    const after = psy.computeBalances([p, other], absences, duties, YEAR.start, YEAR.end,
      { Anna: goesHalfTime });

    const pick = (b, name) => plain(b.rows).find((r) => r.name === name);
    assert.equal(pick(before, 'Anna').pointsH, pick(after, 'Anna').pointsH, 'points must not move');
    assert.ok(
      pick(after, 'Anna').expectedH < pick(before, 'Anna').expectedH,
      'but she is now due less, so her balance rises and she gets fewer shifts'
    );
    assert.ok(pick(after, 'Anna').balanceH > pick(before, 'Anna').balanceH);
  });
});
