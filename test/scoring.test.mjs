import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPure, defaultConfig, plain } from './harness.mjs';

const psy = loadPure();
const config = defaultConfig(psy);

// 2026-12-25 is a Friday, 26th a Saturday, 27th a Sunday.
// 2026-10-01 is a Thursday, 2026-10-06 a Tuesday.
const holidays = {
  '2026-12-24': 'protected',
  '2026-12-25': 'protected',
  '2026-12-31': 'protected',
  '2027-01-01': 'protected',
  '2026-11-11': 'public',
  '2026-12-27': 'public' // a Sunday that is also a public holiday
};

test('civil dates', async (t) => {
  await t.test('should_return_friday_when_date_is_2026_12_25', () => {
    assert.equal(psy.isoDayOfWeek('2026-12-25'), 5);
  });

  await t.test('should_return_thursday_when_date_is_2026_10_01', () => {
    assert.equal(psy.isoDayOfWeek('2026-10-01'), 4);
  });

  await t.test('should_cross_year_boundary_when_adding_days', () => {
    assert.equal(psy.isoAddDays('2026-12-31', 1), '2027-01-01');
    assert.equal(psy.isoAddDays('2027-01-01', -1), '2026-12-31');
  });

  await t.test('should_handle_leap_day_when_year_is_leap', () => {
    assert.equal(psy.isoAddDays('2028-02-28', 1), '2028-02-29');
    assert.equal(psy.isoDaysBetween('2028-02-01', '2028-02-29'), 29);
  });

  await t.test('should_span_1_oct_to_30_sep_when_asked_for_a_period', () => {
    assert.deepEqual(plain(psy.periodFor('2026-11-05')), { start: '2026-10-01', end: '2027-09-30' });
    assert.deepEqual(plain(psy.periodFor('2027-03-05')), { start: '2026-10-01', end: '2027-09-30' });
    assert.deepEqual(plain(psy.periodFor('2026-09-30')), { start: '2025-10-01', end: '2026-09-30' });
  });

  await t.test('should_cover_1095_slots_when_period_is_a_normal_year', () => {
    const dates = psy.isoRange('2026-10-01', '2027-09-30');
    assert.equal(dates.length * 3, 1095);
  });

  await t.test('should_return_31_dates_when_month_is_october', () => {
    assert.equal(psy.monthDates(2026, 10).length, 31);
    assert.equal(psy.monthDates(2026, 12)[30], '2026-12-31');
  });
});

test('fixed point', async (t) => {
  await t.test('should_convert_exactly_when_value_has_two_decimals', () => {
    assert.equal(psy.toHundredths(1.5), 150);
    assert.equal(psy.toHundredths(2.2), 220);
    assert.equal(psy.toHundredths(13.2), 1320);
    assert.equal(psy.fromHundredths(1320), 13.2);
  });

  await t.test('should_not_drift_when_summing_many_values', () => {
    // The float trap this exists to avoid: 0.1 + 0.2 !== 0.3
    let sum = 0;
    for (let i = 0; i < 1000; i++) sum += psy.toHundredths(1.1);
    assert.equal(sum, 110000);
    assert.equal(psy.fromHundredths(sum), 1100);
  });
});

test('scoring', async (t) => {
  await t.test('should_price_1st_on_a_weekday_at_base_when_no_multiplier_applies', () => {
    assert.equal(psy.pointsFor('1st', '2026-10-06', holidays, config), 600);
  });

  await t.test('should_apply_the_weekend_multiplier_when_date_is_saturday', () => {
    // 3rd on a Saturday: 1 x 1.5
    assert.equal(psy.pointsFor('3rd', '2026-12-26', holidays, config), 150);
  });

  await t.test('should_apply_the_friday_multiplier_when_date_is_friday', () => {
    // 2026-12-18 is a Friday and not a holiday: 6 x 1.2
    assert.equal(psy.isoDayOfWeek('2026-12-18'), 5);
    assert.equal(psy.pointsFor('1st', '2026-12-18', holidays, config), 720);
  });

  await t.test('should_price_1st_on_christmas_at_13_2_when_protected', () => {
    assert.equal(psy.pointsFor('1st', '2026-12-25', holidays, config), 1320);
  });

  // README §2.2 — the rule the whole ledger's readability depends on.
  await t.test('should_take_highest_multiplier_when_sunday_is_also_a_public_holiday', () => {
    const priced = psy.priceExplain('1st', '2026-12-27', holidays, config);
    assert.equal(psy.isoDayOfWeek('2026-12-27'), 0, 'precondition: it is a Sunday');
    assert.deepEqual(plain(priced.applicableKinds), ['sun', 'public']);
    assert.equal(priced.multH, 180, 'public 1.8 beats sunday 1.5');
    assert.equal(priced.pointsH, 1080, 'not 1.5 x 1.8 = 2.7 compounded');
  });

  await t.test('should_never_compound_when_several_day_kinds_apply', () => {
    for (const iso of Object.keys(holidays)) {
      const priced = psy.priceExplain('1st', iso, holidays, config);
      const compounded = priced.applicableKinds
        .reduce((acc, kind) => acc * (config.multH[kind] / 100), 1);
      assert.ok(
        priced.multH / 100 <= compounded,
        iso + ': multiplier must never exceed the compounded product'
      );
      assert.ok(
        priced.multH === Math.max(...priced.applicableKinds.map((k) => config.multH[k])),
        iso + ': highest applicable multiplier must win'
      );
    }
  });

  await t.test('should_span_13_2_times_when_comparing_lightest_and_heaviest', () => {
    const lightest = psy.pointsFor('3rd', '2026-10-06', holidays, config);
    const heaviest = psy.pointsFor('1st', '2026-12-25', holidays, config);
    assert.equal(lightest, 100);
    assert.equal(heaviest, 1320);
  });

  await t.test('should_explain_the_workings_when_pricing_a_duty', () => {
    const priced = psy.priceExplain('2nd', '2026-12-26', holidays, config);
    assert.equal(priced.text, '2nd on 2026-12-26 (sat): 3 x 1.5 = 4.5');
  });
});

test('escalation readiness', async (t) => {
  await t.test('should_allow_every_post_when_person_has_no_restrictions', () => {
    const person = { name: 'A', restrictions: [] };
    for (const post of psy.POSTS) assert.equal(psy.mayHoldPost(person, post), true);
  });

  // README §5.1: holding 3rd means being one drop-out from 2nd and two from 1st.
  await t.test('should_block_all_posts_when_person_cannot_run_a_1st', () => {
    const person = { name: 'A', restrictions: ['1st'] };
    assert.equal(psy.mayHoldPost(person, '1st'), false);
    assert.equal(psy.mayHoldPost(person, '2nd'), false, '2nd escalates to 1st');
    assert.equal(psy.mayHoldPost(person, '3rd'), false, '3rd escalates to 1st');
  });

  await t.test('should_block_only_lighter_posts_when_person_cannot_run_a_2nd', () => {
    const person = { name: 'A', restrictions: ['2nd'] };
    assert.equal(psy.mayHoldPost(person, '1st'), true);
    assert.equal(psy.mayHoldPost(person, '2nd'), false);
    assert.equal(psy.mayHoldPost(person, '3rd'), false);
  });
});
