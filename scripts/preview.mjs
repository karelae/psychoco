/**
 * Render the group's board locally, with demo data, as a standalone HTML file.
 *
 *   node scripts/preview.mjs            -> preview/board.html
 *   node scripts/preview.mjs --you Nora -> highlight one person's rows
 *
 * The board normally runs as an Apps Script Web App, where 80_webapp.gs builds
 * the data and HtmlService substitutes it into board.html. This does the same
 * two steps outside Google so the UI can be looked at without deploying: it
 * mirrors buildBoardData(), then replaces the one template placeholder.
 *
 * Because it reuses the real template, what you see here is what the group sees.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScenario } from './scenario.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const youArg = process.argv.indexOf('--you');
const YOU = youArg > -1 ? process.argv[youArg + 1] : 'Nora';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const s = buildScenario([[2026, 10], [2026, 11], [2026, 12], [2027, 1]]);
const psy = s.psy;

const board = psy.computeBalances(
  s.people, s.absencesByName, s.ledger, s.period.start, s.asOf, s.fractionSpansByName
);

// Mirrors buildBoardData() in 80_webapp.gs. Note what is absent: no absence
// rows, no absence reasons, no email addresses. Availability leaves as a day
// count and nothing more (README §7.1).
const data = {
  period: { start: s.period.start, end: s.period.end, operator: 'Demo operator' },
  today: s.asOf,
  you: YOU,
  targetRate: psy.fromHundredths(board.targetRateH),
  totalPoints: psy.fromHundredths(board.totalPointsH),
  configVersion: s.config.version,
  scoring: {
    base: {
      '1st': psy.fromHundredths(s.config.baseH['1st']),
      '2nd': psy.fromHundredths(s.config.baseH['2nd']),
      '3rd': psy.fromHundredths(s.config.baseH['3rd'])
    },
    multipliers: psy.DAY_KINDS.reduce((acc, kind) => {
      acc[kind] = psy.fromHundredths(s.config.multH[kind]);
      return acc;
    }, {})
  },
  rows: board.rows.map((r) => ({
    name: r.name,
    availableDays: Math.round(r.availH / 100),
    points: psy.fromHundredths(r.pointsH),
    expected: psy.fromHundredths(r.expectedH),
    balance: psy.fromHundredths(r.balanceH),
    rate: psy.fromHundredths(r.rateH)
  })),
  // Mirrors upcomingCalendar() in 80_webapp.gs. The real board starts from
  // today; here "today" is the last day generated, so show from December on
  // instead of an empty calendar.
  upcoming: upcomingCalendar('2026-12-01', 150),
  // Mirrors yourDuty() in 80_webapp.gs — uncapped on purpose.
  yours: yourDuty('2026-12-01', YOU)
};

function yourDuty(fromIso, name) {
  if (!name) return [];
  return s.roster
    .filter((r) => r.name === name && r.date >= fromIso)
    .sort((a, b) => (a.date === b.date
      ? psy.POST_RANK[a.post] - psy.POST_RANK[b.post]
      : (a.date < b.date ? -1 : 1)))
    .map((r) => {
      const holiday = psy.isHolidayDay(r.date, s.holidays);
      const heavy = psy.isHeavyDay(r.date, s.holidays);
      return {
        date: r.date,
        day: psy.DOW_SHORT[psy.isoDayOfWeek(r.date)],
        post: r.post,
        points: psy.fromHundredths(psy.pointsFor(r.post, r.date, s.holidays, s.config)),
        label: holiday ? 'holiday' : (heavy ? 'weekend' : ''),
        heavy
      };
    });
}

function upcomingCalendar(fromIso, maxDays) {
  const byDate = new Map();
  for (const r of s.roster) {
    if (r.date < fromIso) continue;
    if (!byDate.has(r.date)) byDate.set(r.date, {});
    byDate.get(r.date)[r.post] = r.name;
  }

  const months = [];
  const index = new Map();

  for (const iso of [...byDate.keys()].sort().slice(0, maxDays)) {
    const key = iso.slice(0, 7);
    if (!index.has(key)) {
      index.set(key, months.length);
      months.push({
        key,
        label: MONTH_NAMES[Number(iso.slice(5, 7)) - 1] + ' ' + iso.slice(0, 4),
        days: []
      });
    }
    const holiday = psy.isHolidayDay(iso, s.holidays);
    const heavy = psy.isHeavyDay(iso, s.holidays);
    months[index.get(key)].days.push({
      date: iso,
      dom: Number(iso.slice(8, 10)),
      weekday: (psy.isoDayOfWeek(iso) + 6) % 7,
      label: holiday ? 'holiday' : (heavy ? 'weekend' : ''),
      heavy,
      posts: byDate.get(iso)
    });
  }

  return { months, weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] };
}

const template = fs.readFileSync(path.join(ROOT, 'apps-script', 'board.html'), 'utf8');
if (!template.includes('<?!= data ?>')) {
  throw new Error('board.html no longer has the <?!= data ?> placeholder — preview needs updating.');
}
const html = template.replace('<?!= data ?>', JSON.stringify(data, null, 2));

const outDir = path.join(ROOT, 'preview');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'board.html');
fs.writeFileSync(outFile, html);

console.log('Wrote ' + path.relative(ROOT, outFile).replace(/\\/g, '/'));
const dayCount = data.upcoming.months.reduce((n, m) => n + m.days.length, 0);
console.log('  ' + data.rows.length + ' people, ' + dayCount + ' rostered days across ' +
  data.upcoming.months.length + ' months, highlighting ' + YOU);
console.log('  Open it in a browser — it is a standalone file, no server needed.');
