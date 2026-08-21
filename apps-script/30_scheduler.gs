/**
 * The scheduler: fill every post on every day of a window, as fairly as the
 * hard constraints allow.
 *
 * PURE and deterministic — same input plus same seed gives the same roster, so
 * it can be golden-file tested (TECHNICAL-README §4.3).
 *
 * Implements the hard constraints of README §5.1 and the trade-offs of
 * TECHNICAL-README §4.2. Generation is per month, which keeps every run fast
 * and, because the balance is rebalanced every month, gives the continuous
 * fairness of README §4 as a side effect rather than as an extra objective.
 *
 * Note on arithmetic: stored points are always integer hundredths. The search
 * objective below uses floating point deliberately — it is a heuristic score,
 * never a ledger value, and nothing derived from it is persisted.
 */

function SchedulingError(message, detail) {
  var e = new Error(message);
  e.name = 'SchedulingError';
  e.detail = detail;
  return e;
}

// ---------------------------------------------------------------------------
// Feasibility
// ---------------------------------------------------------------------------

/**
 * Why a person cannot take a slot, or null if they can.
 *
 * Returning the *reason* rather than a boolean is what lets the scheduler fail
 * loudly and usefully when a day cannot be covered (README §5.1.1).
 */
function placementBlocker(state, slotIdx, name) {
  var slot = state.slots[slotIdx];
  var person = state.personByName[name];
  if (!person) return 'not in the pool';

  if (!mayHoldPost(person, slot.post)) {
    return 'not cleared for ' + slot.post + ' (or for a post it escalates to)';
  }

  var w = poolWindow(person, state.period.start, state.period.end);
  if (!w || slot.date < w.start || slot.date > w.end) {
    return 'outside their arrival–departure window';
  }

  if (state.unavailable[name] && state.unavailable[name][slot.date]) {
    return 'recorded absence';
  }

  var held = state.heldBy[name] || {};
  if (held[slot.date]) {
    return 'already holds ' + held[slot.date] + ' that day';
  }

  // Post-call rest, in both directions: a 1st the day before blocks today, and
  // taking a 1st today requires tomorrow to be free (README §5.1.5).
  if (held[isoAddDays(slot.date, -1)] === '1st') {
    return 'rest day after a 1st on ' + isoAddDays(slot.date, -1);
  }
  if (slot.post === '1st' && held[isoAddDays(slot.date, 1)]) {
    return 'would owe a rest day on ' + isoAddDays(slot.date, 1) + ', already holds ' +
           held[isoAddDays(slot.date, 1)];
  }

  var caps = state.config.caps;

  // Rolling seven-day cap: check every 7-day window that contains this date.
  if (caps.shiftsPerWeek > 0) {
    for (var offset = -6; offset <= 0; offset++) {
      var from = isoAddDays(slot.date, offset);
      var count = 1; // the prospective assignment
      for (var d = 0; d < 7; d++) {
        var iso = isoAddDays(from, d);
        if (iso !== slot.date && held[iso]) count++;
      }
      if (count > caps.shiftsPerWeek) {
        return 'more than ' + caps.shiftsPerWeek + ' posts in the 7 days from ' + from;
      }
    }
  }

  if (caps.shiftsPerMonth > 0) {
    var month = slot.date.slice(0, 7);
    var inMonth = 1;
    for (var iso2 in held) if (iso2.slice(0, 7) === month) inMonth++;
    if (inMonth > caps.shiftsPerMonth) {
      return 'more than ' + caps.shiftsPerMonth + ' posts in ' + month;
    }
  }

  if (slot.heavy && caps.minWeekendGapDays > 0) {
    var gap = caps.minWeekendGapDays;
    for (var k = -(gap - 1); k <= gap - 1; k++) {
      if (k === 0) continue;
      var near = isoAddDays(slot.date, k);
      if (held[near] && state.heavyDates[near]) {
        return 'another weekend or holiday post on ' + near + ', inside the ' + gap + '-day gap';
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// State mutation
// ---------------------------------------------------------------------------

function place(state, slotIdx, name) {
  var slot = state.slots[slotIdx];
  state.assignee[slotIdx] = name;
  if (!state.heldBy[name]) state.heldBy[name] = {};
  state.heldBy[name][slot.date] = slot.post;
  state.carriedH[name] = (state.carriedH[name] || 0) + slot.pointsH;
  if (slot.heavy) state.heavyCount[name] = (state.heavyCount[name] || 0) + 1;
  if (slot.holiday) state.holidayCount[name] = (state.holidayCount[name] || 0) + 1;
  if (slot.post === '1st') state.firstCount[name] = (state.firstCount[name] || 0) + 1;
}

function unplace(state, slotIdx) {
  var slot = state.slots[slotIdx];
  var name = state.assignee[slotIdx];
  if (!name) return null;
  state.assignee[slotIdx] = null;
  delete state.heldBy[name][slot.date];
  state.carriedH[name] -= slot.pointsH;
  if (slot.heavy) state.heavyCount[name] -= 1;
  if (slot.holiday) state.holidayCount[name] -= 1;
  if (slot.post === '1st') state.firstCount[name] -= 1;
  return name;
}

// ---------------------------------------------------------------------------
// Objective
// ---------------------------------------------------------------------------

/**
 * One person's contribution to the objective.
 *
 * The objective is fully decomposable per person, because every expected value
 * it compares against is a constant: all slots get filled, so the totals are
 * known before the search starts. That is what makes each move O(1).
 */
function personCost(state, name) {
  var balance = ((state.carriedH[name] || 0) - (state.expectedH[name] || 0)) / 100;
  var cost = balance * balance;

  var w = state.config.weights;
  if (w.categoryParity > 0) {
    var dHeavy = (state.heavyCount[name] || 0) - (state.expectedHeavy[name] || 0);
    var dHol = (state.holidayCount[name] || 0) - (state.expectedHoliday[name] || 0);
    var dFirst = (state.firstCount[name] || 0) - (state.expectedFirst[name] || 0);
    cost += w.categoryParity * (dHeavy * dHeavy + dHol * dHol + dFirst * dFirst);
  }

  if (w.spacing > 0) {
    cost += w.spacing * spacingPenalty(state, name);
  }
  return cost;
}

/** Penalise posts bunched closer together than MIN_COMFORTABLE_GAP days. */
var MIN_COMFORTABLE_GAP = 4;

function spacingPenalty(state, name) {
  var held = state.heldBy[name];
  if (!held) return 0;
  var days = [];
  for (var iso in held) days.push(isoToDayNumber(iso));
  if (days.length < 2) return 0;
  days.sort(function (a, b) { return a - b; });

  var penalty = 0;
  for (var i = 1; i < days.length; i++) {
    var gap = days[i] - days[i - 1];
    if (gap < MIN_COMFORTABLE_GAP) {
      var shortfall = MIN_COMFORTABLE_GAP - gap;
      penalty += shortfall * shortfall;
    }
  }
  return penalty;
}

function totalObjective(state) {
  var total = 0;
  for (var i = 0; i < state.names.length; i++) total += personCost(state, state.names[i]);
  return total;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Build the roster for `dates`.
 *
 * input: {
 *   dates, people, absencesByName, holidayKindByDate, config,
 *   priorDuties, priorAssignments, period
 * }
 */
function generateRoster(input) {
  var state = buildState(input);

  // Greedy seed: heaviest slots first, each to whoever is most owed. Doing the
  // expensive days first matters — they are the ones there is least room to
  // correct later.
  var order = state.slots.map(function (s, i) { return i; });
  order.sort(function (a, b) {
    var sa = state.slots[a], sb = state.slots[b];
    if (sb.pointsH !== sa.pointsH) return sb.pointsH - sa.pointsH;
    if (sa.date !== sb.date) return sa.date < sb.date ? -1 : 1;
    return POST_RANK[sa.post] - POST_RANK[sb.post];
  });

  for (var o = 0; o < order.length; o++) {
    var idx = order[o];
    var best = null;
    var bestScore = 0;
    var blockers = {};

    for (var n = 0; n < state.names.length; n++) {
      var name = state.names[n];
      var blocker = placementBlocker(state, idx, name);
      if (blocker) { blockers[name] = blocker; continue; }
      var deficit = (state.carriedH[name] || 0) - (state.expectedH[name] || 0);
      if (best === null || deficit < bestScore) { best = name; bestScore = deficit; }
    }

    if (best === null) {
      var slot = state.slots[idx];
      throw SchedulingError(
        'Cannot cover ' + slot.post + ' on ' + slot.date + ': every member of the pool is blocked.',
        { date: slot.date, post: slot.post, blockers: blockers }
      );
    }
    place(state, idx, best);
  }

  var result = localSearch(state);
  return {
    assignments: state.slots.map(function (slot, i) {
      return {
        date: slot.date,
        post: slot.post,
        name: state.assignee[i],
        pointsH: slot.pointsH,
        origin: 'auto',
        reason: 'balance-driven; ' + slot.post + ' on ' + slot.date +
                ' worth ' + fromHundredths(slot.pointsH) + ' points'
      };
    }),
    objectiveBefore: result.before,
    objectiveAfter: result.after,
    movesAccepted: result.accepted,
    movesTried: result.tried
  };
}

/**
 * Local search over swaps and reassignments. Every intermediate state is a
 * valid, fully covered roster, so this can stop at any point and still hand
 * back something usable (TECHNICAL-README §4.3).
 */
function localSearch(state) {
  var rng = mulberry32(state.config.search.seed);
  var iterations = state.config.search.iterations;
  var before = totalObjective(state);
  var accepted = 0;
  var tried = 0;
  var slotCount = state.slots.length;
  if (slotCount < 2) return { before: before, after: before, accepted: 0, tried: 0 };

  for (var it = 0; it < iterations; it++) {
    tried++;
    var i = Math.floor(rng() * slotCount);
    var j = Math.floor(rng() * slotCount);
    if (i === j) continue;

    var nameI = state.assignee[i];
    var nameJ = state.assignee[j];
    if (nameI === nameJ) continue;

    var costBefore = personCost(state, nameI) + personCost(state, nameJ);

    unplace(state, i);
    unplace(state, j);

    var okI = placementBlocker(state, i, nameJ) === null;
    var okJ = okI && placementBlocker(state, j, nameI) === null;

    if (!okJ) {
      place(state, i, nameI);
      place(state, j, nameJ);
      continue;
    }

    place(state, i, nameJ);
    place(state, j, nameI);
    var costAfter = personCost(state, nameI) + personCost(state, nameJ);

    if (costAfter < costBefore) {
      accepted++;
    } else {
      unplace(state, i);
      unplace(state, j);
      place(state, i, nameI);
      place(state, j, nameJ);
    }
  }

  return { before: before, after: totalObjective(state), accepted: accepted, tried: tried };
}

/** Assemble the working state, including everything already committed. */
function buildState(input) {
  var config = input.config;
  var period = input.period;
  var holidays = input.holidayKindByDate || {};

  var slots = [];
  for (var d = 0; d < input.dates.length; d++) {
    var iso = input.dates[d];
    for (var p = 0; p < POSTS.length; p++) {
      var post = POSTS[p];
      slots.push({
        date: iso,
        post: post,
        pointsH: pointsFor(post, iso, holidays, config),
        heavy: isHeavyDay(iso, holidays),
        holiday: isHolidayDay(iso, holidays)
      });
    }
  }

  var heavyDates = {};
  var allDates = isoRange(period.start, period.end);
  for (var a = 0; a < allDates.length; a++) {
    if (isHeavyDay(allDates[a], holidays)) heavyDates[allDates[a]] = true;
  }

  var absencesByName = input.absencesByName || {};

  var personByName = {};
  var names = [];
  for (var i = 0; i < input.people.length; i++) {
    personByName[input.people[i].name] = input.people[i];
    names.push(input.people[i].name);
  }

  // Dates each person cannot be rostered on: every absence counts here, not
  // only the ones that reduce their fair share (see 20_fairness.gs).
  var unavailable = {};
  for (var n = 0; n < names.length; n++) {
    unavailable[names[n]] = absentDates(absencesByName[names[n]] || [], {
      from: period.start, to: period.end
    });
  }

  // Everything already committed in this period: worked duties, plus planned
  // assignments outside the window being generated.
  var heldBy = {};
  var carriedH = {};
  var heavyCount = {};
  var holidayCount = {};
  var firstCount = {};
  var priorPointsByName = {};

  function commit(row, countPoints) {
    if (!heldBy[row.name]) heldBy[row.name] = {};
    heldBy[row.name][row.date] = row.post;
    var pts = row.pointsH !== undefined
      ? row.pointsH
      : pointsFor(row.post, row.date, holidays, config);
    if (countPoints) {
      carriedH[row.name] = (carriedH[row.name] || 0) + pts;
      priorPointsByName[row.name] = (priorPointsByName[row.name] || 0) + pts;
    }
    if (isHeavyDay(row.date, holidays)) heavyCount[row.name] = (heavyCount[row.name] || 0) + 1;
    if (isHolidayDay(row.date, holidays)) holidayCount[row.name] = (holidayCount[row.name] || 0) + 1;
    if (row.post === '1st') firstCount[row.name] = (firstCount[row.name] || 0) + 1;
  }

  var windowDates = {};
  for (var wd = 0; wd < input.dates.length; wd++) windowDates[input.dates[wd]] = true;

  (input.priorDuties || []).forEach(function (r) { commit(r, true); });
  (input.priorAssignments || []).forEach(function (r) {
    if (!windowDates[r.date]) commit(r, true);
  });

  var windowPointsH = 0;
  for (var s = 0; s < slots.length; s++) windowPointsH += slots[s].pointsH;

  // Availability is measured *as of the end of this window*, not the end of the
  // period. Using the period end would tell the scheduler that somebody who
  // joined last week is owed a whole year's worth of duty right now, and it
  // would dutifully front-load it onto them — precisely the "load them up early
  // and compensate later" failure README §4 rules out.
  var asOf = input.dates[input.dates.length - 1];
  var shares = expectedShares(
    input.people, absencesByName, priorPointsByName, windowPointsH,
    period.start, asOf, input.fractionSpansByName
  );

  // Expected counts are availability-weighted too: someone present for half the
  // period should carry half the weekends, not the same number.
  var totalHeavy = 0, totalHoliday = 0, totalFirst = 0;
  for (var t = 0; t < slots.length; t++) {
    if (slots[t].heavy) totalHeavy++;
    if (slots[t].holiday) totalHoliday++;
    if (slots[t].post === '1st') totalFirst++;
  }
  for (var pn in heavyCount) totalHeavy += heavyCount[pn];
  for (var pn2 in holidayCount) totalHoliday += holidayCount[pn2];
  for (var pn3 in firstCount) totalFirst += firstCount[pn3];

  var expectedHeavy = {}, expectedHoliday = {}, expectedFirst = {};
  for (var k = 0; k < names.length; k++) {
    var share = shares.totalAvailH === 0 ? 0 : shares.availH[names[k]] / shares.totalAvailH;
    expectedHeavy[names[k]] = totalHeavy * share;
    expectedHoliday[names[k]] = totalHoliday * share;
    expectedFirst[names[k]] = totalFirst * share;
  }

  return {
    slots: slots,
    assignee: slots.map(function () { return null; }),
    names: names,
    personByName: personByName,
    unavailable: unavailable,
    heldBy: heldBy,
    carriedH: carriedH,
    heavyCount: heavyCount,
    holidayCount: holidayCount,
    firstCount: firstCount,
    expectedH: shares.expectedH,
    expectedHeavy: expectedHeavy,
    expectedHoliday: expectedHoliday,
    expectedFirst: expectedFirst,
    heavyDates: heavyDates,
    config: config,
    period: period,
    holidayKindByDate: holidays
  };
}

/**
 * Who could have had this slot, and why the rest could not.
 *
 * README §5.2 requires every assignment to be explainable. Computed on demand
 * from the current roster rather than frozen at generation time, so the answer
 * stays true after manual overrides.
 */
function explainAssignment(input, date, post) {
  var state = buildState(input);
  var slotIdx = -1;
  for (var i = 0; i < state.slots.length; i++) {
    if (state.slots[i].date === date && state.slots[i].post === post) { slotIdx = i; break; }
  }
  if (slotIdx < 0) throw new Error('No slot for ' + post + ' on ' + date);

  // Re-commit the roster as it stands, minus the slot being explained.
  (input.priorAssignments || []).forEach(function (r) {
    if (r.date === date && r.post === post) return;
    var idx = -1;
    for (var k = 0; k < state.slots.length; k++) {
      if (state.slots[k].date === r.date && state.slots[k].post === r.post) { idx = k; break; }
    }
    if (idx >= 0 && state.personByName[r.name]) place(state, idx, r.name);
  });

  var eligible = [];
  var blocked = [];
  for (var n = 0; n < state.names.length; n++) {
    var name = state.names[n];
    var blocker = placementBlocker(state, slotIdx, name);
    var deficitH = (state.carriedH[name] || 0) - (state.expectedH[name] || 0);
    if (blocker) blocked.push({ name: name, reason: blocker });
    else eligible.push({ name: name, deficitH: deficitH });
  }
  eligible.sort(function (a, b) { return a.deficitH - b.deficitH; });

  return {
    date: date,
    post: post,
    pointsH: state.slots[slotIdx].pointsH,
    price: priceExplain(post, date, state.holidayKindByDate, state.config),
    eligible: eligible,
    blocked: blocked
  };
}
