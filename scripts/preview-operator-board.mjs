/**
 * Render the operator's board locally, as a standalone HTML file.
 *
 *   node scripts/preview-operator-board.mjs      -> preview/operator-board.html
 *
 * The board normally runs as an Apps Script Web App: 80_webapp.gs builds the
 * payload, HtmlService stitches board.html and operator.html together, and the
 * operator's clicks go back to the server through google.script.run. None of
 * that exists outside Google, so this does the same three things another way:
 *
 *   1. builds the viewer payload the way buildBoardData() does, plus the
 *      `operator` block the server adds for one reader only;
 *   2. substitutes board.html's two template placeholders — the data and the
 *      operator layer — so what you see is the real template, not a mock-up;
 *   3. loads the pure modules (00-30) into the page and answers the operator
 *      client's calls from them, in place of google.script.run.
 *
 * Point 3 is what makes this worth having: every price, every shortlist, every
 * ruled-out reason and every balance on the page is computed by the same code
 * that will run on the server, so the design can be judged on real numbers
 * rather than on plausible-looking ones. Writes mutate the page's copy of the
 * scenario and vanish on reload.
 *
 * This file is a development tool, not part of the app. The stub below is the
 * shape the eventual server functions have to match.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScenario } from './scenario.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Mid-January: three months are published, two more are rostered but not yet
// credited, and there is both a past to settle and a future to reassign. Where a
// period actually sits when somebody calls in sick.
const TODAY = '2027-01-14';
const PUBLISHED_BEFORE = '2027-01-01';

// The operator is on the rota like everybody else (the sketch's first premise),
// so this is a name from the pool, not a separate account.
const OPERATOR = { name: 'Karel', email: 'karel@example.org' };

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const s = buildScenario([[2026, 10], [2026, 11], [2026, 12], [2027, 1], [2027, 2]]);
const psy = s.psy;

const price = (post, date) => psy.pointsFor(post, date, s.holidays, s.config);
const byPost = (a, b) => psy.POST_RANK[a.post] - psy.POST_RANK[b.post];
const dayRoster = (date) => s.roster.filter((r) => r.date === date).sort(byPost);

// Only published months are credited (TECHNICAL-README §2.1) — the roster runs
// further ahead than the ledger, which is the normal state of things.
const ledger = s.ledger.filter((d) => d.date < PUBLISHED_BEFORE);
const escalations = [];

/**
 * Apply a drop-out to the scenario the way recordDropout() does: the chain
 * shifts up, someone comes in at the vacated post, the day is re-priced, and the
 * person who dropped out is credited nothing.
 *
 * Done properly rather than faked, because the pool panel is meant to answer
 * "why am I getting the heavy ones?" — and it can only do that if the drop-outs
 * on screen are the same events that moved the balances above them.
 */
function applyDropout(date, dropper) {
  const day = dayRoster(date);
  const index = day.findIndex((r) => r.name === dropper);
  if (index < 0) throw new Error(dropper + ' is not rostered on ' + date);

  const worked = [];
  for (let p = index; p < day.length - 1; p++) {
    worked.push({ post: day[p].post, name: day[p + 1].name, from: day[p + 1].post });
  }
  for (let q = 0; q < index; q++) {
    worked.push({ post: day[q].post, name: day[q].name, from: day[q].post });
  }
  const vacantPost = day[day.length - 1].post;

  const backfill = topCandidate(date, vacantPost, worked, dropper);
  if (backfill) worked.push({ post: vacantPost, name: backfill, from: null });

  for (let i = ledger.length - 1; i >= 0; i--) {
    if (ledger[i].date === date) ledger.splice(i, 1);
  }
  worked.forEach((w) => ledger.push({
    date, post: w.post, name: w.name,
    pointsH: price(w.post, date), configVersion: s.config.version
  }));

  // A single day is far under the recalibration threshold, so this keeps them
  // off the roster without lowering what they are expected to carry
  // (README §3.1.1). The missed points are the whole correction.
  s.absencesByName[dropper] = (s.absencesByName[dropper] || [])
    .concat([{ from: date, to: date, type: 'drop-out', reduces: false }]);

  escalations.push({
    date,
    droppedOut: dropper,
    droppedPost: day[index].post,
    forgoneH: price(day[index].post, date),
    chain: worked.filter((w) => w.from).map((w) => w.name + ' → ' + w.post).join(', '),
    backfill: backfill || '(uncovered)'
  });
}

/** Most owed among those who could take a post — the scheduler's own ranking. */
function topCandidate(date, post, workedSoFar, excluded) {
  const explained = psy.explainAssignment({
    dates: [date],
    people: s.people,
    absencesByName: s.absencesByName,
    fractionSpansByName: s.fractionSpansByName,
    holidayKindByDate: s.holidays,
    config: s.config,
    priorDuties: ledger.filter((d) => d.date !== date),
    priorAssignments: s.roster.filter((r) => r.date !== date)
      .concat(workedSoFar.map((w) => ({ date, post: w.post, name: w.name }))),
    period: s.period
  }, date, post);
  // Never the person who dropped out — see the same filter in the stub.
  const eligible = explained.eligible.filter((c) => c.name !== excluded);
  return eligible.length ? eligible[0].name : '';
}

// Three drop-outs, chosen so the pool panel has something to say: a weekend
// first call, the same person again a few weeks later, and somebody else on a
// public holiday.
const weekendFirst = dayRoster('2026-10-24').find((r) => r.post === '1st');
const again = s.roster.find((r) => r.name === weekendFirst.name &&
  r.date > '2026-11-05' && r.date < '2026-12-20');
const holidaySecond = dayRoster('2026-11-11').find((r) => r.post === '2nd');

applyDropout(weekendFirst.date, weekendFirst.name);
if (again) applyDropout(again.date, again.name);
applyDropout(holidaySecond.date, holidaySecond.name);

// --- the payload -----------------------------------------------------------

const standing = psy.computeBalances(
  s.people, s.absencesByName, ledger, s.period.start, TODAY, s.fractionSpansByName
);

// The same projection buildBoardData() now does, so the viewer half of this
// page shows what the group would really be served.
const planned = psy.projectedDuties(s.roster, ledger, s.holidays, s.config);
const plannedH = {};
for (const d of planned.duties) plannedH[d.name] = (plannedH[d.name] || 0) + d.pointsH;
const ahead = planned.horizon > TODAY
  ? psy.computeBalances(s.people, s.absencesByName, ledger.concat(planned.duties),
      s.period.start, planned.horizon, s.fractionSpansByName)
  : standing;
const projectedH = {};
for (const r of ahead.rows) projectedH[r.name] = r.balanceH;

const dropoutsByName = {};
escalations.forEach((e) => {
  dropoutsByName[e.droppedOut] = (dropoutsByName[e.droppedOut] || 0) + 1;
});

const data = {
  period: { start: s.period.start, end: s.period.end, operator: OPERATOR.name },
  today: TODAY,
  horizon: planned.horizon > TODAY ? planned.horizon : '',
  you: OPERATOR.name,
  targetRate: psy.fromHundredths(standing.targetRateH),
  totalPoints: psy.fromHundredths(standing.totalPointsH),
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
  rows: standing.rows.map(standingRow),
  yours: yourDuty(TODAY, OPERATOR.name),
  upcoming: upcomingCalendar(TODAY, 150),
  // The block 80_webapp.gs adds for one reader and nobody else. Note what is
  // *not* in it: no absence rows, no reasons, no drop-out detail. Those are
  // fetched per person, on request, from a function that re-checks the caller.
  operator: {
    email: OPERATOR.email,
    name: OPERATOR.name,
    dropoutsByName
  }
};

function standingRow(r) {
  return {
    name: r.name,
    availableDays: Math.round(r.availH / 100),
    points: psy.fromHundredths(r.pointsH),
    expected: psy.fromHundredths(r.expectedH),
    balance: psy.fromHundredths(r.balanceH),
    rate: psy.fromHundredths(r.rateH),
    rosteredPoints: psy.fromHundredths(plannedH[r.name] || 0),
    projectedBalance: psy.fromHundredths(projectedH[r.name] || 0)
  };
}

function yourDuty(fromIso, name) {
  return s.roster
    .filter((r) => r.name === name && r.date >= fromIso)
    .sort((a, b) => (a.date === b.date ? byPost(a, b) : (a.date < b.date ? -1 : 1)))
    .map((r) => {
      const heavy = psy.isHeavyDay(r.date, s.holidays);
      return {
        date: r.date,
        day: psy.DOW_SHORT[psy.isoDayOfWeek(r.date)],
        post: r.post,
        points: psy.fromHundredths(price(r.post, r.date)),
        label: psy.isHolidayDay(r.date, s.holidays) ? 'holiday' : (heavy ? 'weekend' : ''),
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
    const heavy = psy.isHeavyDay(iso, s.holidays);
    months[index.get(key)].days.push({
      date: iso,
      dom: Number(iso.slice(8, 10)),
      weekday: (psy.isoDayOfWeek(iso) + 6) % 7,
      label: psy.isHolidayDay(iso, s.holidays) ? 'holiday' : (heavy ? 'weekend' : ''),
      heavy,
      posts: byDate.get(iso)
    });
  }

  return { months, weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] };
}

// --- the stand-in for the server ------------------------------------------

/**
 * Everything the operator client calls, answered from the pure modules.
 *
 * Written as a function and serialised into the page rather than kept as a
 * string, so it stays ordinary readable JavaScript. It runs in the browser, so
 * it may only use its argument and the pure-module globals loaded alongside it.
 *
 * This is the contract 90_operator.gs has to implement — same names, same
 * shapes — with one addition it cannot have here: every write verifying the
 * caller is the operator before it touches anything.
 */
function opsStubFactory(S) {
  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function dec(h) { return fromHundredths(h); }
  function priceH(post, date) { return pointsFor(post, date, S.holidays, S.config); }
  function byPost(a, b) { return POST_RANK[a.post] - POST_RANK[b.post]; }
  function dayRoster(date) {
    return S.roster.filter(function (r) { return r.date === date; }).sort(byPost);
  }
  function settled(date) {
    return S.ledger.some(function (d) { return d.date === date; });
  }
  function standing(absencesByName, fractionSpansByName, end) {
    return computeBalances(
      S.people,
      absencesByName || S.absencesByName,
      S.ledger,
      S.period.start,
      end || S.today,
      fractionSpansByName || S.fractionSpansByName
    );
  }
  function rowFor(result, name) {
    return result.rows.filter(function (r) { return r.name === name; })[0];
  }

  /**
   * The four numbers worth comparing before a stretch away is written.
   *
   * Two of them are measured over the whole period and two as things stand
   * today, which is not an inconsistency: recalibration works on the days a
   * person is in the pool for, and most leave is recorded before it starts. A
   * comparison that only looked at today would read "no change" for every future
   * absence and teach the operator that the form does nothing.
   */
  function measures(name, absences, spans) {
    var toDate = standing(absences, spans);
    var whole = standing(absences, spans, S.period.end);
    var here = rowFor(toDate, name);
    var all = rowFor(whole, name);
    return {
      availPeriod: Math.round(all.availH / 100),
      share: whole.totalAvailH ? (all.availH * 100) / whole.totalAvailH : 0,
      expected: dec(here.expectedH),
      balance: dec(here.balanceH)
    };
  }
  function effectRows(before, after) {
    return [
      { label: 'Available days, whole period', before: before.availPeriod, after: after.availPeriod, digits: 0 },
      { label: 'Share of the pool', before: before.share, after: after.share, digits: 2, unit: '%' },
      { label: 'Expected of them so far', before: before.expected, after: after.expected, digits: 2 },
      { label: 'Balance today', before: before.balance, after: after.balance, digits: 2 }
    ];
  }
  function effectNote(before, after) {
    if (before.expected !== after.expected || before.balance !== after.balance) {
      return 'Part of the span has already passed, so what is expected of them so far ' +
        'moves with it.';
    }
    return 'Nothing already earned moves — the dates are still ahead. This only changes ' +
      'what is expected of them from here on, which is the point of recording it.';
  }
  function explain(date, post, priorAssignments) {
    return explainAssignment({
      dates: [date],
      people: S.people,
      absencesByName: S.absencesByName,
      fractionSpansByName: S.fractionSpansByName,
      holidayKindByDate: S.holidays,
      config: S.config,
      priorDuties: S.ledger.filter(function (d) { return d.date !== date; }),
      priorAssignments: priorAssignments,
      period: S.period
    }, date, post);
  }
  function shortlistOf(explained) {
    return explained.eligible.slice(0, 8).map(function (c) {
      return { name: c.name, balance: dec(c.deficitH) };
    });
  }
  function blockedOf(explained) {
    return explained.blocked.map(function (b) { return { name: b.name, reason: b.reason }; });
  }
  /**
   * Every rostered post the ledger has not credited yet.
   *
   * Matched on date and post rather than on name, so a day settled as a
   * drop-out counts as credited even though the roster still names whoever was
   * originally down for it (TECHNICAL-README §2.1 — plan and record are
   * separate, and the record wins).
   */
  function plannedDuties() {
    var credited = {};
    S.ledger.forEach(function (d) { credited[d.date + '|' + d.post] = true; });
    return S.roster.filter(function (r) {
      return !credited[r.date + '|' + r.post];
    }).map(function (r) {
      return { date: r.date, post: r.post, name: r.name, pointsH: priceH(r.post, r.date) };
    });
  }

  /** The last day anybody is rostered for — how far a projection can honestly see. */
  function horizon(planned) {
    var last = '';
    planned.forEach(function (d) { if (d.date > last) last = d.date; });
    return last > S.today ? last : '';
  }

  function clone(map) {
    var out = {};
    Object.keys(map).forEach(function (key) { out[key] = (map[key] || []).slice(); });
    return out;
  }

  return {
    opsDay: function (req) {
      var explained = priceExplain('1st', req.date, S.holidays, S.config);
      return {
        date: req.date,
        weekday: WEEKDAYS[isoDayOfWeek(req.date)],
        dayKind: explained.dayKind,
        multiplier: dec(explained.multH),
        configVersion: S.config.version,
        settled: settled(req.date),
        posts: dayRoster(req.date).map(function (r) {
          return { post: r.post, name: r.name, points: dec(priceH(r.post, req.date)) };
        })
      };
    },

    /**
     * The chain shift. README §1.2: everyone below the drop-out moves up one
     * post, the bottom post falls vacant, and points follow the post actually
     * worked (§2.4) — which is why each move carries what it was worth before.
     */
    opsCascade: function (req) {
      var day = dayRoster(req.date);
      var index = -1;
      for (var i = 0; i < day.length; i++) if (day[i].name === req.dropper) index = i;
      if (index < 0) throw new Error(req.dropper + ' is not rostered on ' + req.date);

      var moves = [];
      for (var p = index; p < day.length - 1; p++) {
        moves.push({
          post: day[p].post,
          name: day[p + 1].name,
          from: day[p + 1].post,
          was: dec(priceH(day[p + 1].post, req.date)),
          points: dec(priceH(day[p].post, req.date))
        });
      }
      var vacantPost = day[day.length - 1].post;

      var explained = explain(req.date, vacantPost,
        S.roster.filter(function (r) { return r.date !== req.date; })
          .concat(moves.map(function (m) {
            return { date: req.date, post: m.post, name: m.name };
          })));

      // Whoever just called in sick is not a candidate to cover the same day.
      // Nothing in the constraint model rules them out — their absence is not
      // recorded until the day is settled — so it has to be done here.
      var shortlist = shortlistOf(explained).filter(function (c) {
        return c.name !== req.dropper;
      });

      return {
        date: req.date,
        dropper: req.dropper,
        droppedPost: day[index].post,
        forgone: dec(priceH(day[index].post, req.date)),
        moves: moves,
        vacantPost: vacantPost,
        vacantPoints: dec(priceH(vacantPost, req.date)),
        shortlist: shortlist,
        blocked: blockedOf(explained)
      };
    },

    opsShortlist: function (req) {
      var explained = explain(req.date, req.post, S.roster);
      var current = dayRoster(req.date).filter(function (r) { return r.post === req.post; })[0];
      var held = current ? current.name : '';
      var priced = priceExplain(req.post, req.date, S.holidays, S.config);

      return {
        date: req.date,
        post: req.post,
        // The arithmetic only. explainAssignment's own sentence repeats the date
        // and post, which the heading has already said.
        price: dec(priced.baseH) + ' × ' + dec(priced.multH) + ' = ' +
          dec(priced.pointsH) + ' points (' + priced.dayKind + ')',
        current: held,
        settled: settled(req.date),
        // Whoever holds the post is eligible for it by construction — offering
        // them as an alternative to themselves is noise.
        shortlist: shortlistOf(explained).filter(function (c) { return c.name !== held; }),
        blocked: blockedOf(explained)
      };
    },

    /**
     * One person's record. README §7.1 is explicit that the drop-out pattern is
     * the operator's alone and never a board feature, which is exactly why it is
     * behind a per-person call rather than in the page.
     */
    opsPerson: function (req) {
      var drops = S.escalations.filter(function (e) { return e.droppedOut === req.name; });
      var absences = (S.absencesByName[req.name] || []).filter(function (a) {
        return a.type !== 'drop-out';
      });
      var awayDays = 0;
      absences.forEach(function (a) { awayDays += isoDaysBetween(a.from, a.to); });

      var upcoming = plannedDuties().filter(function (d) { return d.name === req.name; })
        .sort(function (a, b) {
          if (a.date !== b.date) return a.date < b.date ? -1 : 1;
          return POST_RANK[a.post] - POST_RANK[b.post];
        });

      return {
        name: req.name,
        dropouts: drops.map(function (e) {
          return {
            date: e.date,
            post: e.droppedPost,
            dayKind: priceExplain(e.droppedPost, e.date, S.holidays, S.config).dayKind,
            forgone: dec(e.forgoneH),
            covered: e.chain
              ? e.chain + ', ' + (e.backfill === '(uncovered)'
                ? 'nobody took the vacated post'
                : e.backfill + ' came in')
              : 'no chain recorded'
          };
        }),
        forgoneTotal: dec(drops.reduce(function (sum, e) { return sum + e.forgoneH; }, 0)),
        absences: absences.map(function (a) {
          return {
            from: a.from, to: a.to, type: a.type || 'leave',
            days: isoDaysBetween(a.from, a.to), reduces: !!a.reduces
          };
        }),
        fractions: (S.fractionSpansByName[req.name] || []).map(function (f) {
          return { from: f.from, to: f.to, fraction: f.fractionH };
        }),
        awayDays: awayDays,
        upcoming: upcoming.map(function (d) {
          return {
            date: d.date, post: d.post, points: dec(d.pointsH),
            dayKind: priceExplain(d.post, d.date, S.holidays, S.config).dayKind
          };
        }),
        plannedTotal: dec(upcoming.reduce(function (sum, d) { return sum + d.pointsH; }, 0))
      };
    },

    /**
     * The standing as earned, and the standing the current roster is heading
     * for.
     *
     * The projection is not arithmetic on top of the balances — it is the same
     * computeBalances() over the ledger plus everything still rostered, run out
     * to the end of the roster so availability is measured over the same window
     * the points cover. Anything else would compare a person's earned points
     * against a share of a period they have not been measured across.
     */
    opsStanding: function () {
      var result = standing();
      var planned = plannedDuties();
      var end = horizon(planned);

      var plannedH = {};
      planned.forEach(function (d) {
        plannedH[d.name] = (plannedH[d.name] || 0) + d.pointsH;
      });

      var ahead = end
        ? computeBalances(S.people, S.absencesByName, S.ledger.concat(planned),
            S.period.start, end, S.fractionSpansByName)
        : result;
      var projectedH = {};
      ahead.rows.forEach(function (r) { projectedH[r.name] = r.balanceH; });

      var counts = {};
      S.escalations.forEach(function (e) {
        counts[e.droppedOut] = (counts[e.droppedOut] || 0) + 1;
      });

      return {
        rows: result.rows.map(function (r) {
          return {
            name: r.name,
            availableDays: Math.round(r.availH / 100),
            points: dec(r.pointsH),
            expected: dec(r.expectedH),
            balance: dec(r.balanceH),
            rate: dec(r.rateH),
            rosteredPoints: dec(plannedH[r.name] || 0),
            projectedBalance: dec(projectedH[r.name] || 0)
          };
        }),
        totalPoints: dec(result.totalPointsH),
        targetRate: dec(result.targetRateH),
        horizon: end,
        dropoutsByName: counts
      };
    },

    /**
     * What a stretch away would do, before it is written.
     *
     * The two-week rule (README §3.1.1) is derived here, not asked: an operator
     * should not have to know the threshold to record leave correctly. A change
     * of hours is a different record entirely — a workload span, which is not
     * retroactive — and is previewed the same way.
     */
    opsAwayPreview: function (req) {
      if (!req.name || !req.from || !req.to) return { error: 'Pick a person and the dates.' };
      if (req.to < req.from) return { error: 'The end date is before the start date.' };

      var before = measures(req.name);
      var threshold = (S.config.absence && S.config.absence.minRecalibratingDays) || 14;

      if (req.kind === 'absence') {
        var days = isoDaysBetween(req.from, req.to);
        var recalibrates = days >= threshold;
        var absences = clone(S.absencesByName);
        absences[req.name] = (absences[req.name] || []).concat([{
          from: req.from, to: req.to, type: req.type, reduces: recalibrates
        }]);
        var after = measures(req.name, absences);

        // Leave does not move a rostered post on its own. Saying so, with the
        // dates, is the difference between a form and a trap.
        var clashes = S.roster.filter(function (r) {
          return r.name === req.name && r.date >= req.from && r.date <= req.to;
        }).sort(function (a, b) { return a.date < b.date ? -1 : 1; })
          .map(function (r) { return { date: r.date, post: r.post }; });

        // A span can run past somebody's departure, past the end of the period,
        // or over days a part-timer only counts a fraction of. When the days
        // that actually count differ from the days typed in, say so — otherwise
        // the change column looks like an arithmetic error.
        var counted = before.availPeriod - after.availPeriod;
        var note = recalibrates ? effectNote(before, after) : '';
        if (recalibrates && counted !== days) {
          note = 'Only ' + counted + ' of those ' + days + ' days count towards their ' +
            'availability — the rest fall outside the period or their time in the pool, ' +
            'or are scaled by their working fraction. ' + note;
        }

        return {
          kind: 'absence', name: req.name, days: days, threshold: threshold,
          recalibrates: recalibrates,
          rows: effectRows(before, after),
          note: note,
          clashes: clashes
        };
      }

      var spans = clone(S.fractionSpansByName);
      spans[req.name] = (spans[req.name] || []).concat([{
        from: req.from, to: req.to, fractionH: req.fraction
      }]);
      var afterSpan = measures(req.name, null, spans);
      return {
        kind: 'fraction', name: req.name, from: req.from, fraction: req.fraction,
        rows: effectRows(before, afterSpan),
        note: effectNote(before, afterSpan),
        clashes: []
      };
    },

    // --- the writes ---------------------------------------------------------
    // In the preview these mutate the page's copy of the scenario, so the rest
    // of the board reacts as it would to a real write. On the server each one
    // must first confirm the caller is the operator, then audit.

    opsSettleDay: function (req) {
      var day = dayRoster(req.date);
      var index = -1;
      for (var i = 0; i < day.length; i++) if (day[i].name === req.dropper) index = i;

      var worked = [];
      for (var p = index; p < day.length - 1; p++) {
        worked.push({ post: day[p].post, name: day[p + 1].name, from: day[p + 1].post });
      }
      for (var q = 0; q < index; q++) {
        worked.push({ post: day[q].post, name: day[q].name, from: day[q].post });
      }
      var vacantPost = day[day.length - 1].post;
      if (req.backfill) worked.push({ post: vacantPost, name: req.backfill, from: null });

      for (var l = S.ledger.length - 1; l >= 0; l--) {
        if (S.ledger[l].date === req.date) S.ledger.splice(l, 1);
      }
      var creditedH = 0;
      worked.forEach(function (w) {
        var pointsH = priceH(w.post, req.date);
        creditedH += pointsH;
        S.ledger.push({
          date: req.date, post: w.post, name: w.name,
          pointsH: pointsH, configVersion: S.config.version
        });
      });

      S.absencesByName[req.dropper] = (S.absencesByName[req.dropper] || []).concat([{
        from: req.date, to: req.date, type: 'drop-out', reduces: false
      }]);
      S.escalations.push({
        date: req.date,
        droppedOut: req.dropper,
        droppedPost: day[index].post,
        forgoneH: priceH(day[index].post, req.date),
        chain: worked.filter(function (w) { return w.from; })
          .map(function (w) { return w.name + ' → ' + w.post; }).join(', '),
        backfill: req.backfill || '(uncovered)'
      });

      return {
        summary: req.date + ' settled — ' + req.dropper + ' dropped ' + day[index].post +
          ', ' + worked.length + ' duties credited (' + dec(creditedH) + ' points), ' +
          (req.backfill ? req.backfill + ' came in at ' + vacantPost
            : vacantPost + ' recorded as uncovered')
      };
    },

    opsReassign: function (req) {
      var replaced = '';
      S.roster.forEach(function (r) {
        if (r.date === req.date && r.post === req.post) {
          replaced = r.name;
          r.name = req.name;
          r.origin = 'manual';
          r.reason = req.reason;
        }
      });
      return {
        summary: req.post + ' on ' + req.date + ' reassigned from ' +
          (replaced || 'nobody') + ' to ' + req.name + ' — ' + req.reason
      };
    },

    opsRecordAway: function (req) {
      if (req.kind === 'absence') {
        var threshold = (S.config.absence && S.config.absence.minRecalibratingDays) || 14;
        var days = isoDaysBetween(req.from, req.to);
        var reduces = days >= threshold;
        S.absencesByName[req.name] = (S.absencesByName[req.name] || []).concat([{
          from: req.from, to: req.to, type: req.type, reduces: reduces
        }]);
        return {
          summary: req.name + ' away ' + req.from + ' → ' + req.to + ' (' + days + ' days, ' +
            req.type + ')' + (reduces
              ? ' — expected share lowered with it'
              : ' — under the ' + threshold + '-day threshold, expected share unchanged')
        };
      }
      S.fractionSpansByName[req.name] = (S.fractionSpansByName[req.name] || []).concat([{
        from: req.from, to: req.to, fractionH: req.fraction
      }]);
      return {
        summary: req.name + ' at ' + req.fraction + '% of full time from ' + req.from +
          ' to ' + req.to + ' — earlier days keep the fraction they had'
      };
    }
  };
}

// --- compose the page -----------------------------------------------------

const PURE_FILES = ['00_schema.gs', '10_scoring.gs', '20_fairness.gs', '30_scheduler.gs'];
const pureSource = PURE_FILES
  .map((file) => fs.readFileSync(path.join(ROOT, 'apps-script', file), 'utf8'))
  .join('\n;\n');

const scenario = {
  period: s.period,
  today: TODAY,
  people: s.people,
  absencesByName: s.absencesByName,
  fractionSpansByName: s.fractionSpansByName,
  holidays: s.holidays,
  config: s.config,
  roster: s.roster,
  ledger,
  escalations
};

const template = fs.readFileSync(path.join(ROOT, 'apps-script', 'board.html'), 'utf8');
for (const placeholder of ['<?!= data ?>', '<?!= operatorLayer ?>']) {
  if (!template.includes(placeholder)) {
    throw new Error('board.html no longer has the ' + placeholder +
      ' placeholder — this preview needs updating.');
  }
}

const operatorLayer = fs.readFileSync(path.join(ROOT, 'apps-script', 'operator.html'), 'utf8');

// The pure modules and the stub have to be parsed before board.html's own script
// runs, because that is what calls PsychocoOps.init(). The operator layer is
// substituted in above it, so this rides along with it.
const backend = [
  operatorLayer,
  '<script>',
  pureSource,
  '</script>',
  '<script>',
  'window.PSYCHOCO_OPS_STUB = (' + opsStubFactory.toString() + ')(',
  JSON.stringify(scenario),
  ');',
  '</script>'
].join('\n');

const html = template
  .replace('<?!= data ?>', JSON.stringify(data, null, 2))
  .replace('<?!= operatorLayer ?>', backend)
  // HtmlService adds this at serve time, not in the template, so a standalone
  // file would otherwise render zoomed out and hide the phone layout — which is
  // the layout that matters most for settling a drop-out.
  .replace('<meta charset="utf-8">',
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">');

const outDir = path.join(ROOT, 'preview');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'operator-board.html');
fs.writeFileSync(outFile, html);

console.log('Wrote ' + path.relative(ROOT, outFile).replace(/\\/g, '/'));
console.log('  ' + data.rows.length + ' people, ' + ledger.length + ' credited duties, ' +
  s.roster.length + ' rostered posts, ' + escalations.length + ' drop-outs on record');
console.log('  operator ' + OPERATOR.name + ' <' + OPERATOR.email + '>, "today" is ' + TODAY);
console.log('  Open it in a browser. Every button works against the real pure modules;');
console.log('  writes change the page and are forgotten on reload.');
