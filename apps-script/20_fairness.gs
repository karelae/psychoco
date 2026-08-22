/**
 * Fairness: points per available day.
 *
 * PURE. Implements README §3. Balances are always derived from the ledger and
 * never stored (TECHNICAL-README §3.3), so this is the only place that decides
 * who is owed what.
 */

/**
 * The part of the period a person actually belongs to the pool for.
 * Returns null when they do not overlap the period at all.
 */
function poolWindow(person, periodStart, periodEnd) {
  var start = person.arrival && person.arrival > periodStart ? person.arrival : periodStart;
  var end = person.departure && person.departure < periodEnd ? person.departure : periodEnd;
  if (isoToDayNumber(end) < isoToDayNumber(start)) return null;
  return { start: start, end: end };
}

/**
 * Dates on which a person is unavailable, as a set.
 *
 * Note the distinction from availability-for-fairness below: *every* absence
 * makes someone unavailable to be rostered, but only absences flagged as
 * reducing availability shrink the denominator their fair share is measured
 * against. A day off in lieu should not be rostered over, and arguably should
 * not lower what you are expected to carry either (README §3.1).
 */
function absentDates(absences, opts) {
  var onlyReducing = opts && opts.onlyReducing;
  var clipStart = opts && opts.from;
  var clipEnd = opts && opts.to;
  var out = {};

  for (var i = 0; i < absences.length; i++) {
    var a = absences[i];
    if (onlyReducing && !a.reduces) continue;

    var from = clipStart && a.from < clipStart ? clipStart : a.from;
    var to = clipEnd && a.to > clipEnd ? clipEnd : a.to;
    if (isoToDayNumber(to) < isoToDayNumber(from)) continue;

    var dates = isoRange(from, to);
    for (var j = 0; j < dates.length; j++) out[dates[j]] = true;
  }
  return out;
}

/**
 * The working fraction in force for a person on one date.
 *
 * A fraction is not a property of a person, it is a property of a person on a
 * date. Somebody who works full time until February and half time afterwards was
 * genuinely fully available in October, and treating their current fraction as
 * if it had always applied would understate the availability they actually had.
 *
 * Later rows win, so a correction can simply be appended.
 */
function fractionHOn(person, spans, iso) {
  var fraction = person.fractionH === undefined || person.fractionH === null ? 100 : person.fractionH;
  if (!spans || !spans.length) return fraction;
  for (var i = 0; i < spans.length; i++) {
    if (iso >= spans[i].from && iso <= spans[i].to) fraction = spans[i].fractionH;
  }
  return fraction;
}

/**
 * Available days for a person, in hundredths of a day.
 *
 * Summed day by day rather than multiplied, because the working fraction can
 * change part-way through the period. With no spans this is exactly
 * (days in pool - reducing absence days) x fraction.
 */
function availableDayHundredths(person, absences, periodStart, periodEnd, fractionSpans) {
  // Somebody who cannot hold any post is not on the rota, so they carry no
  // expected share. Counting them would give them a deficit that can never be
  // repaid and would quietly lower everyone else's fair share.
  if (!canHoldAnyPost(person)) return 0;

  var w = poolWindow(person, periodStart, periodEnd);
  if (!w) return 0;

  var absent = absentDates(absences || [], { onlyReducing: true, from: w.start, to: w.end });
  var dates = isoRange(w.start, w.end);
  var total = 0;
  for (var i = 0; i < dates.length; i++) {
    if (absent[dates[i]]) continue;
    total += fractionHOn(person, fractionSpans, dates[i]);
  }
  return total;
}

/**
 * The board: what everyone has carried, what they were due, and the gap.
 *
 * `expected` is computed as totalPoints x available / totalAvailable — one
 * division, performed last, so error cannot accumulate across the period
 * (TECHNICAL-README §3.4).
 *
 * Returned most-owed first, which is the order the scheduler and the drop-out
 * shortlist both consume.
 */
function computeBalances(people, absencesByName, dutyRows, periodStart, periodEnd, fractionSpansByName) {
  var pointsByName = {};
  for (var i = 0; i < dutyRows.length; i++) {
    var d = dutyRows[i];
    pointsByName[d.name] = (pointsByName[d.name] || 0) + d.pointsH;
  }

  var rows = [];
  var totalPointsH = 0;
  var totalAvailH = 0;

  for (var p = 0; p < people.length; p++) {
    var person = people[p];
    var availH = availableDayHundredths(
      person, absencesByName[person.name] || [], periodStart, periodEnd,
      (fractionSpansByName || {})[person.name]
    );
    var pointsH = pointsByName[person.name] || 0;
    totalPointsH += pointsH;
    totalAvailH += availH;
    rows.push({ name: person.name, availH: availH, pointsH: pointsH });
  }

  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    row.expectedH = totalAvailH === 0
      ? 0
      : Math.round((totalPointsH * row.availH) / totalAvailH);
    row.balanceH = row.pointsH - row.expectedH;
    // Points per available day, in hundredths of a point per day, for display.
    row.rateH = row.availH === 0 ? 0 : Math.round((row.pointsH * 100) / row.availH);
  }

  rows.sort(function (a, b) {
    if (a.balanceH !== b.balanceH) return a.balanceH - b.balanceH;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });

  return {
    rows: rows,
    totalPointsH: totalPointsH,
    totalAvailH: totalAvailH,
    targetRateH: totalAvailH === 0 ? 0 : Math.round((totalPointsH * 100) / totalAvailH)
  };
}

/**
 * Expected share per person for a *known* total — used by the scheduler, where
 * the total points in the window are fixed before anything is assigned.
 *
 * This is what makes local search cheap: expected is constant, so a swap only
 * changes two people's carried points (TECHNICAL-README §4.3).
 */
function expectedShares(people, absencesByName, priorPointsByName, windowPointsH, periodStart, periodEnd, fractionSpansByName) {
  var availH = {};
  var totalAvailH = 0;
  var totalPriorH = 0;

  for (var i = 0; i < people.length; i++) {
    var person = people[i];
    var a = availableDayHundredths(
      person, absencesByName[person.name] || [], periodStart, periodEnd,
      (fractionSpansByName || {})[person.name]
    );
    availH[person.name] = a;
    totalAvailH += a;
    totalPriorH += priorPointsByName[person.name] || 0;
  }

  var totalH = totalPriorH + windowPointsH;
  var expectedH = {};
  for (var n in availH) {
    expectedH[n] = totalAvailH === 0 ? 0 : Math.round((totalH * availH[n]) / totalAvailH);
  }
  return { expectedH: expectedH, availH: availH, totalAvailH: totalAvailH, totalH: totalH };
}

/**
 * The rostered posts the ledger has not credited yet, priced, and the last date
 * they run to.
 *
 * This is what lets a balance be projected forward: today's balance answers
 * "has this been fair so far", and the same computeBalances() over the ledger
 * plus these answers "is it about to be". Both questions get asked, and the
 * second one is the one somebody halfway through a heavy month is really
 * asking (README §3).
 *
 * Credited is matched on date and post, never on name. A day settled as a
 * drop-out is credited even though the Roster tab still names whoever was
 * originally down for it — plan and record are separate, and the record wins
 * (TECHNICAL-README §2.1).
 */
function projectedDuties(roster, ledger, holidayKindByDate, config) {
  var credited = {};
  for (var i = 0; i < ledger.length; i++) {
    credited[ledger[i].date + '|' + ledger[i].post] = true;
  }

  var duties = [];
  var horizon = '';
  for (var r = 0; r < roster.length; r++) {
    var row = roster[r];
    if (credited[row.date + '|' + row.post]) continue;
    duties.push({
      date: row.date,
      post: row.post,
      name: row.name,
      pointsH: pointsFor(row.post, row.date, holidayKindByDate, config)
    });
    if (row.date > horizon) horizon = row.date;
  }
  return { duties: duties, horizon: horizon };
}
