/**
 * Run the real scheduler against a realistic pool, with no Google account and
 * no deployment. Generates and publishes three consecutive months so you can
 * see the balance staying level across them.
 *
 *   node scripts/demo.mjs
 *   node scripts/demo.mjs 2026-12      # show a different month's roster
 *
 * For the group's web board, see scripts/preview.mjs.
 */

import { buildScenario, PERIOD, HOLIDAYS, psy } from './scenario.mjs';

const SHOW = process.argv[2] || '2026-12';
const scenario = buildScenario();
const { people, absencesByName, fractionSpansByName, config, ledger, roster, runs, asOf } = scenario;

function pad(s, n) { return String(s).padEnd(n); }
function padL(s, n) { return String(s).padStart(n); }
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// --- what generation did ---------------------------------------------------

console.log('\nPsychoco — scheduling ' + people.length + ' people, ' +
  'period ' + PERIOD.start + ' to ' + PERIOD.end + '\n');

for (const run of runs) {
  console.log(pad(run.label, 9) +
    padL(run.result.assignments.length, 3) + ' posts  ' +
    padL(run.ms + 'ms', 7) + '   ' +
    padL(run.result.movesAccepted, 4) + ' improving swaps   ' +
    'objective ' + padL(run.result.objectiveBefore.toFixed(0), 6) + ' →' +
    padL(run.result.objectiveAfter.toFixed(0), 6));
}

// --- the roster for one month --------------------------------------------

const [sy, sm] = SHOW.split('-').map(Number);
const showDates = psy.monthDates(sy, sm);
const byDate = {};
roster.filter((r) => r.date >= showDates[0] && r.date <= showDates[showDates.length - 1])
  .forEach((r) => {
    if (!byDate[r.date]) byDate[r.date] = {};
    byDate[r.date][r.post] = r.name;
  });

console.log('\n\nRoster for ' + SHOW + '\n');
console.log(pad('Date', 12) + pad('Day', 5) + pad('Kind', 15) +
  pad('1st', 11) + pad('2nd', 11) + pad('3rd', 11) + padL('Points', 7));
console.log('-'.repeat(79));

for (const iso of showDates) {
  const row = byDate[iso] || {};
  const kinds = psy.applicableDayKinds(iso, HOLIDAYS);
  const priced = psy.multiplierFor(iso, HOLIDAYS, config);
  const dayPoints = psy.POSTS.reduce((acc, p) => acc + psy.pointsFor(p, iso, HOLIDAYS, config), 0);
  const heavy = psy.isHeavyDay(iso, HOLIDAYS);

  console.log(
    pad(iso, 12) + pad(DOW[psy.isoDayOfWeek(iso)], 5) +
    pad(priced.kind + ' ×' + psy.fromHundredths(priced.multH), 15) +
    pad(row['1st'] || '—', 11) + pad(row['2nd'] || '—', 11) + pad(row['3rd'] || '—', 11) +
    padL(psy.fromHundredths(dayPoints).toFixed(1), 7) + (heavy ? '  ←' : '')
  );
}

// --- the board -----------------------------------------------------------

// As of the last day generated, not the end of the period. Measuring against
// whole-period availability would make anyone who leaves mid-period look
// overloaded, because their share is scaled by months they have not worked yet.
const board = psy.computeBalances(
  people, absencesByName, ledger, PERIOD.start, asOf, fractionSpansByName
);

console.log('\n\nStanding after ' + runs.length + ' months' +
  '   (target rate ' + psy.fromHundredths(board.targetRateH) + ' points per available day)\n');
console.log(pad('Name', 11) + padL('Avail', 7) + padL('Carried', 9) +
  padL('Due', 8) + padL('Balance', 9) + '   notes');
console.log('-'.repeat(72));

const counts = {};
ledger.forEach((d) => {
  if (!counts[d.name]) counts[d.name] = { n: 0, first: 0, heavy: 0 };
  counts[d.name].n++;
  if (d.post === '1st') counts[d.name].first++;
  if (psy.isHeavyDay(d.date, HOLIDAYS)) counts[d.name].heavy++;
});

for (const r of board.rows) {
  const p = people.find((x) => x.name === r.name);
  const notes = [];
  if (p.fractionH !== 100) notes.push(psy.fromHundredths(p.fractionH) + ' FTE');
  if (p.arrival !== PERIOD.start) notes.push('joined ' + p.arrival);
  if (p.departure) notes.push('leaves ' + p.departure);
  if (p.restrictions.length) notes.push('no ' + p.restrictions.join('/'));
  if ((absencesByName[r.name] || []).length) notes.push('leave');
  const c = counts[r.name] || { n: 0, first: 0, heavy: 0 };

  console.log(
    pad(r.name, 11) + padL(Math.round(r.availH / 100), 7) +
    padL(psy.fromHundredths(r.pointsH).toFixed(1), 9) +
    padL(psy.fromHundredths(r.expectedH).toFixed(1), 8) +
    padL((r.balanceH > 0 ? '+' : '') + psy.fromHundredths(r.balanceH).toFixed(1), 9) +
    '   ' + pad(c.n + ' posts, ' + c.first + ' firsts, ' + c.heavy + ' heavy', 32) +
    notes.join(', ')
  );
}

const worst = Math.max(...board.rows.map((r) => Math.abs(r.balanceH)));
console.log('\nWorst individual balance: ' + psy.fromHundredths(worst).toFixed(2) +
  ' points — a first call on Christmas is worth ' +
  psy.fromHundredths(psy.pointsFor('1st', '2026-12-25', HOLIDAYS, config)) + '.');

// --- one explanation -----------------------------------------------------

const explained = psy.explainAssignment({
  dates: ['2026-12-25'],
  people, absencesByName, holidayKindByDate: HOLIDAYS, config,
  priorDuties: ledger.filter((d) => d.date !== '2026-12-25'),
  priorAssignments: roster,
  period: PERIOD
}, '2026-12-25', '1st');

console.log('\n\nWhy this person? — 1st on 2026-12-25\n');
console.log('  ' + explained.price.text);
console.log('  rostered: ' + (byDate['2026-12-25'] ? byDate['2026-12-25']['1st'] : 'n/a'));
console.log('\n  most owed among those who could take it:');
explained.eligible.slice(0, 5).forEach((c) => {
  console.log('    ' + pad(c.name, 11) + 'balance ' + psy.fromHundredths(c.deficitH).toFixed(1));
});
console.log('\n  ruled out (' + explained.blocked.length + ' of ' + people.length + '), for example:');
explained.blocked.slice(0, 5).forEach((b) => {
  console.log('    ' + pad(b.name, 11) + b.reason);
});
console.log('');
