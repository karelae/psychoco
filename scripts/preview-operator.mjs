/**
 * Render what the operator sees, as a standalone HTML page.
 *
 *   node scripts/preview-operator.mjs   -> preview/operator.html
 *
 * The operator's interface is the workbook itself plus the Psychoco menu, so
 * this shows the tab structure with realistic rows, the menu, and the real text
 * of the one dialog that matters most — "why this person?".
 *
 * Tabs and headers come from HEADERS in 00_schema.gs and the rows from the same
 * scenario the demo uses, so this cannot drift from the real thing. The page
 * template is inline because it is a development tool, not part of the app.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScenario } from './scenario.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const s = buildScenario();
const psy = s.psy;
const T = psy.TABS;

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const fmt = (v) => (typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : v);

/** Rows for each tab, in the column order HEADERS declares. */
function sampleRows(tabName) {
  const byName = (n) => s.people.find((p) => p.name === n);
  const dec = s.roster.filter((r) => r.date >= '2026-12-24' && r.date <= '2026-12-26');

  switch (tabName) {
    case T.PERIOD:
      return [[s.period.start, s.period.end, 'Karel']];

    case T.PEOPLE:
      return ['Amira', 'Dries', 'Hannes', 'Marie', 'Sofie', 'Emma'].map((n) => {
        const p = byName(n);
        return [p.name, p.arrival, p.departure || '', psy.fromHundredths(p.fractionH),
          p.restrictions.join(', '), p.email];
      });

    case T.ABSENCES:
      return Object.keys(s.absencesByName).flatMap((name) =>
        s.absencesByName[name].map((a) => [name, a.from, a.to, 'leave', true]));

    case T.WORKLOAD:
      return Object.keys(s.fractionSpansByName).flatMap((name) =>
        s.fractionSpansByName[name].map((f) =>
          [name, f.from, f.to, psy.fromHundredths(f.fractionH), 'dropped to 80% from February']));

    case T.HOLIDAYS:
      return Object.keys(s.holidays).slice(0, 6).map((iso) => [iso, s.holidays[iso], '']);

    case T.CONFIG:
      return psy.DEFAULT_CONFIG.map((e) => [1, s.period.start, e[0], e[1], e[2]]);

    case T.ROSTER:
      return dec.map((r) => [r.date, r.post, r.name, 'auto',
        'balance-driven; ' + r.post + ' on ' + r.date]);

    case T.LEDGER:
      return dec.map((r) => [r.date, r.post, r.name,
        psy.fromHundredths(psy.pointsFor(r.post, r.date, s.holidays, s.config)), 1]);

    case T.ESCALATIONS:
      return [['2027-01-14', 'Bram', 'Camille → 1st, Dries → 2nd', 'Elke',
        'drop-out recorded by the operator']];

    case T.AUDIT:
      return [
        ['2026-11-28 09:14:02', 'psychoco@example.org (operator: Karel)', 'generateMonth',
          '2026-12: 93 assignments, config v1'],
        ['2026-12-01 08:02:41', 'psychoco@example.org (operator: Karel)', 'publishMonth',
          '2026-11: 90 duties, 379.4 points, config v1'],
        ['2027-01-14 07:11:55', 'psychoco@example.org (operator: Karel)', 'recordDropout',
          '2027-01-14: Bram dropped out; Camille → 1st, Dries → 2nd; 3rd → Elke']
      ];

    default:
      return [];
  }
}

const NOTES = {
  [T.PERIOD]: 'One row. The operator’s name here is the only attribution the audit trail has.',
  [T.PEOPLE]: 'The cohort. Restrictions is normally empty — Marie shows what happens when it is not: a restriction on 1st rules out every post, so she is excluded from the rota and from the balance.',
  [T.ABSENCES]: 'Date-bounded, so leave only reduces availability for the days it covers.',
  [T.WORKLOAD]: 'Only needed when somebody’s hours change part-way through the period. Overrides the People fraction for those dates alone.',
  [T.HOLIDAYS]: 'Nothing else in the system knows what a holiday is. Weekends are derived from the date.',
  [T.CONFIG]: 'The whole value judgement, editable by the operator. Versioned — every ledger row records the version it was priced under.',
  [T.ROSTER]: 'What was planned. Generating again replaces it. Nothing here counts.',
  [T.LEDGER]: 'What actually happened, and the only thing that earns points. Protected with a warning.',
  [T.ESCALATIONS]: 'Written by Record a drop-out. Illustrative row — the demo scenario has no drop-outs.',
  [T.AUDIT]: 'Appended by every mutation. Illustrative rows.'
};

const MENU = [
  ['Open the board', 'The same read-only board the group sees, in a dialog.'],
  ['Generate roster for a month…', 'Asks for YYYY-MM. Warns before replacing an existing month. Fails loudly and names the blocking constraint if a day cannot be covered.'],
  ['Publish a month to the ledger…', 'Prices every rostered duty and credits it. Shows the total and asks to confirm, because this moves everyone’s balance. Skips days already settled.'],
  ['Record a drop-out…', 'Asks the date and who dropped out, applies the chain shift, ranks who is most owed for the vacated post, then writes the day to the ledger.'],
  ['Explain an assignment…', 'Asks for a date and post. Shows the pricing, who was eligible with their balances, and why everyone else was ruled out.'],
  ['Check for problems', 'Runs every invariant check and lists what it finds.'],
  ['Set up workbook…', 'Creates the tabs, validation and protected ranges, and seeds the placeholder config.']
];

// The real output of the explain dialog, generated rather than mocked.
const explained = psy.explainAssignment({
  dates: ['2026-12-25'],
  people: s.people,
  absencesByName: s.absencesByName,
  fractionSpansByName: s.fractionSpansByName,
  holidayKindByDate: s.holidays,
  config: s.config,
  priorDuties: s.ledger.filter((d) => d.date !== '2026-12-25'),
  priorAssignments: s.roster,
  period: s.period
}, '2026-12-25', '1st');

const rostered = s.roster.find((r) => r.date === '2026-12-25' && r.post === '1st');
const explainText = [
  explained.price.text,
  '',
  'Rostered: ' + (rostered ? rostered.name : 'nobody'),
  '',
  'Most owed among those who could take it:',
  ...explained.eligible.slice(0, 6).map((c) =>
    '  ' + c.name.padEnd(11) + 'balance ' + psy.fromHundredths(c.deficitH).toFixed(1)),
  '',
  'Ruled out (' + explained.blocked.length + '):',
  ...explained.blocked.slice(0, 6).map((b) => '  ' + b.name.padEnd(11) + b.reason)
].join('\n');

const tabsHtml = Object.keys(T).map((key) => {
  const name = T[key];
  const headers = psy.HEADERS[name];
  const rows = sampleRows(name);
  return `
  <section>
    <h3>${esc(name)} <span class="cols">${headers.length} columns</span></h3>
    <p class="note">${esc(NOTES[name] || '')}</p>
    <div class="scroll"><table>
      <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${headers
        .map((_, i) => `<td>${esc(fmt(r[i]))}</td>`).join('')}</tr>`).join('')}
      ${rows.length ? '' : '<tr><td class="muted">empty</td></tr>'}</tbody>
    </table></div>
  </section>`;
}).join('');

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Psychoco — the operator's view</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { --bg:#fff; --fg:#1a1a1a; --muted:#6b6b6b; --line:#e2e2e2; --accent:#2b4c7e;
          --panel:#f7f7f5; --head:#efefef; }
  * { box-sizing:border-box; }
  body { margin:0; padding:1.5rem; background:var(--bg); color:var(--fg);
         font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  .wrap { max-width:62rem; margin:0 auto; }
  h1 { font-size:1.4rem; margin:0 0 .25rem; }
  h2 { font-size:1rem; margin:2.5rem 0 .75rem; text-transform:uppercase;
       letter-spacing:.06em; color:var(--muted); }
  h3 { font-size:.95rem; margin:1.75rem 0 .2rem; }
  h3 .cols { font-weight:400; color:var(--muted); font-size:.8rem; margin-left:.4rem; }
  .lede { color:var(--muted); max-width:44rem; }
  .scroll { overflow-x:auto; border:1px solid var(--line); border-radius:4px; }
  table { border-collapse:collapse; width:100%; font-size:.85rem; }
  th,td { text-align:left; padding:.35rem .55rem; border-bottom:1px solid var(--line);
          white-space:nowrap; }
  th { background:var(--head); font-size:.75rem; text-transform:uppercase;
       letter-spacing:.03em; color:var(--muted); }
  tr:last-child td { border-bottom:0; }
  .note { color:var(--muted); font-size:.82rem; margin:.15rem 0 .45rem; max-width:48rem; }
  .muted { color:var(--muted); }
  .menu { background:var(--panel); border:1px solid var(--line); border-radius:6px;
          padding:.35rem .5rem; max-width:34rem; }
  .menu div { padding:.4rem .5rem; border-bottom:1px solid var(--line); }
  .menu div:last-child { border-bottom:0; }
  .menu b { font-weight:600; }
  .menu span { display:block; color:var(--muted); font-size:.82rem; }
  pre { background:var(--panel); border:1px solid var(--line); border-radius:6px;
        padding:.9rem 1rem; overflow-x:auto; font-size:.82rem; line-height:1.45; margin:0; }
  .caveat { border-left:3px solid var(--accent); padding:.5rem .9rem; background:var(--panel);
            margin:1rem 0; }
</style></head>
<body><div class="wrap">
  <h1>The operator's view</h1>
  <p class="lede">There is no admin dashboard. The operator works in the spreadsheet and
  drives everything from one menu. This page shows the tab structure with realistic rows,
  generated from the same code and scenario the tests use.</p>

  <h2>The menu</h2>
  <div class="menu">${MENU.map(([label, what]) =>
    `<div><b>${esc(label)}</b><span>${esc(what)}</span></div>`).join('')}</div>

  <h2>"Why this person?" — the actual dialog output</h2>
  <p class="note">Generated by <code>explainAssignment()</code>, not mocked. This is what
  the operator can show somebody who thinks the roster treated them badly.</p>
  <pre>${esc(explainText)}</pre>

  <h2>The workbook</h2>
  <div class="caveat">Only the operator ever sees these tabs. The group gets the board,
  because a viewer on the workbook could read individual absence records.</div>
  ${tabsHtml}
</div></body></html>`;

const outDir = path.join(ROOT, 'preview');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'operator.html'), html);
console.log('Wrote preview/operator.html');
console.log('  ' + Object.keys(T).length + ' tabs, ' + MENU.length + ' menu items');
