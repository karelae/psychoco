/**
 * Invariant checks.
 *
 * A spreadsheet cannot enforce the invariants a database would, so they are
 * enforced here instead — run from the menu and on edit. That does not prevent
 * a bad edit, but it turns "silently wrong until September" into "flagged
 * within seconds", which is the difference that matters.
 *
 * Each check corresponds to a row of the invariants table in .claude/CLAUDE.md.
 */

function configsByVersion() {
  var byVersion = {};
  readTable(TABS.CONFIG).forEach(function (r) {
    var v = Number(r['Version']);
    if (!byVersion[v]) byVersion[v] = { version: v, effectiveFrom: asIso(r['Effective from']), values: {} };
    byVersion[v].values[asText(r['Key'])] = r['Value'];
  });

  var parsed = {};
  Object.keys(byVersion).forEach(function (v) {
    try {
      parsed[v] = parseConfig(byVersion[v]);
    } catch (e) {
      parsed[v] = null;
    }
  });
  return parsed;
}

function runValidation() {
  var problems = [];
  function report(where, message) {
    problems.push({ where: where, message: message });
  }

  var period, people, absencesByName, workload, holidays, roster, ledger, configs;
  try {
    period = readPeriod();
    people = readPeople();
    absencesByName = readAbsencesByName(people);
    workload = readWorkloadSpans(people);
    holidays = readHolidays();
    roster = readRoster();
    ledger = readLedger();
    configs = configsByVersion();
  } catch (e) {
    return [{ where: 'Workbook', message: String(e.message || e) }];
  }

  var personByName = {};
  people.forEach(function (p) { personByName[p.name] = p; });

  // Duplicate people
  var seenNames = {};
  people.forEach(function (p) {
    if (seenNames[p.name]) report(TABS.PEOPLE + ' row ' + p._row, 'Duplicate name "' + p.name + '".');
    seenNames[p.name] = true;
  });

  // Somebody restricted from a heavier post is restricted from the lighter ones
  // too, so they can hold nothing. They are excluded from the fairness
  // denominator, but they should not be sitting on the People tab unexplained.
  people.forEach(function (p) {
    if (!canHoldAnyPost(p)) {
      report(TABS.PEOPLE + ' row ' + p._row,
        p.name + ' cannot hold any post (restrictions: ' + p.restrictions.join(', ') +
        '), because a restriction on a heavier post rules out the lighter ones. ' +
        'They are excluded from the rota and from the balance. Remove them, or clear the restriction.');
    }
  });

  // Working-fraction spans. Overlaps are not an error — later rows win, so a
  // correction can be appended — but they are worth surfacing, because an
  // accidental overlap silently changes what somebody is expected to carry.
  Object.keys(workload).forEach(function (name) {
    var spans = workload[name];
    if (spans.length && !personByName[name]) {
      report(TABS.WORKLOAD + ' row ' + spans[0]._row, '"' + name + '" is not on the People tab.');
    }
    spans.forEach(function (s, i) {
      if (isoToDayNumber(s.to) < isoToDayNumber(s.from)) {
        report(TABS.WORKLOAD + ' row ' + s._row, 'To (' + s.to + ') is before From (' + s.from + ').');
      }
      if (s.fractionH <= 0 || s.fractionH > 100) {
        report(TABS.WORKLOAD + ' row ' + s._row,
          'Fraction is ' + fromHundredths(s.fractionH) + '; it must be greater than 0 and at most 1.');
      }
      for (var j = 0; j < i; j++) {
        var other = spans[j];
        if (s.from <= other.to && other.from <= s.to) {
          report(TABS.WORKLOAD + ' row ' + s._row,
            'Overlaps row ' + other._row + ' for ' + name + '. The later row wins for the overlap — ' +
            'intended for a correction, surprising otherwise.');
        }
      }
    });
  });

  // --- Absences ----------------------------------------------------------
  // Every absence keeps somebody off the roster, but only one of at least
  // absence.minRecalibratingDays lowers what they are expected to carry
  // (README §3.1.1). A ticked box on a short absence is either a slip or a
  // policy change nobody agreed to, and it quietly shifts everyone else's
  // fair share, so it is worth naming.
  var currentConfig = null;
  Object.keys(configs).forEach(function (v) {
    if (configs[v] && (!currentConfig || Number(v) > currentConfig.version)) currentConfig = configs[v];
  });
  var minRecalDays = currentConfig ? currentConfig.absence.minRecalibratingDays : 14;

  Object.keys(absencesByName).forEach(function (name) {
    absencesByName[name].forEach(function (a) {
      if (isoToDayNumber(a.to) < isoToDayNumber(a.from)) {
        report(TABS.ABSENCES + ' row ' + a._row, 'To (' + a.to + ') is before From (' + a.from + ').');
        return;
      }
      var days = isoDaysBetween(a.from, a.to);
      if (a.reduces && days < minRecalDays) {
        report(TABS.ABSENCES + ' row ' + a._row,
          name + ' is absent ' + days + (days === 1 ? ' day' : ' days') + ' from ' + a.from +
          ', which is under the ' + minRecalDays + '-day threshold, but "Reduces availability" is ticked. ' +
          'Untick it: they still will not be rostered, and their expected share stays where it is. ' +
          'If the absence really does run longer, correct the To date.');
      }
    });
  });

  // --- Roster ------------------------------------------------------------
  var rosterByDate = {};
  roster.forEach(function (r) {
    if (!rosterByDate[r.date]) rosterByDate[r.date] = [];
    rosterByDate[r.date].push(r);
  });

  Object.keys(rosterByDate).forEach(function (date) {
    var rows = rosterByDate[date];
    var posts = {};
    var namesToday = {};

    rows.forEach(function (r) {
      if (posts[r.post]) {
        report(TABS.ROSTER + ' row ' + r._row, date + ': ' + r.post + ' is filled twice.');
      }
      posts[r.post] = r;

      if (namesToday[r.name]) {
        report(TABS.ROSTER + ' row ' + r._row, date + ': ' + r.name + ' holds two posts.');
      }
      namesToday[r.name] = true;

      if (!personByName[r.name]) {
        report(TABS.ROSTER + ' row ' + r._row, '"' + r.name + '" is not on the People tab.');
        return;
      }
      if (!mayHoldPost(personByName[r.name], r.post)) {
        report(TABS.ROSTER + ' row ' + r._row,
          r.name + ' is not cleared for ' + r.post + ' (or a post it escalates to).');
      }
      var w = poolWindow(personByName[r.name], period.start, period.end);
      if (!w || date < w.start || date > w.end) {
        report(TABS.ROSTER + ' row ' + r._row,
          r.name + ' is rostered on ' + date + ', outside their arrival–departure window.');
      }
      var away = absentDates(absencesByName[r.name] || [], {});
      if (away[date]) {
        report(TABS.ROSTER + ' row ' + r._row, r.name + ' is rostered on ' + date + ' during a recorded absence.');
      }
    });

    // Coverage: three posts, every day (README §1.1).
    for (var i = 0; i < POSTS.length; i++) {
      if (!posts[POSTS[i]]) report(TABS.ROSTER, date + ': no ' + POSTS[i] + ' rostered.');
    }
  });

  // --- Ledger ------------------------------------------------------------
  var ledgerByDate = {};
  ledger.forEach(function (r) {
    if (!ledgerByDate[r.date]) ledgerByDate[r.date] = [];
    ledgerByDate[r.date].push(r);
  });

  Object.keys(ledgerByDate).forEach(function (date) {
    var posts = {};
    var namesToday = {};
    ledgerByDate[date].forEach(function (r) {
      if (posts[r.post]) report(TABS.LEDGER + ' row ' + r._row, date + ': ' + r.post + ' recorded twice.');
      posts[r.post] = true;
      if (namesToday[r.name]) report(TABS.LEDGER + ' row ' + r._row, date + ': ' + r.name + ' recorded twice.');
      namesToday[r.name] = true;
      if (!personByName[r.name]) {
        report(TABS.LEDGER + ' row ' + r._row, '"' + r.name + '" is not on the People tab.');
      }
    });
  });

  checkConsecutiveDays(roster, ledger, report);

  // Points must match the config version they were priced under
  // (TECHNICAL-README §3.2).
  ledger.forEach(function (r) {
    var config = configs[r.configVersion];
    if (!config) {
      report(TABS.LEDGER + ' row ' + r._row,
        'Config version ' + r.configVersion + ' is not on the Config tab, so this price cannot be checked.');
      return;
    }
    var expected;
    try {
      expected = pointsFor(r.post, r.date, holidays, config);
    } catch (e) {
      report(TABS.LEDGER + ' row ' + r._row, String(e.message || e));
      return;
    }
    if (expected !== r.pointsH) {
      report(TABS.LEDGER + ' row ' + r._row,
        r.post + ' on ' + r.date + ' is recorded as ' + fromHundredths(r.pointsH) +
        ' but config v' + r.configVersion + ' prices it at ' + fromHundredths(expected) + '.');
    }
  });

  // --- Period ------------------------------------------------------------
  if (period.start.slice(5) !== '10-01' || period.end.slice(5) !== '09-30') {
    report(TABS.PERIOD, 'The period must run 1 October to 30 September (README §4).');
  }
  if (!period.operator) {
    report(TABS.PERIOD, 'No operator recorded. With a shared account this is the only attribution there is.');
  }

  return problems;
}

/**
 * Nobody is on guard two days running, whichever posts they are (README §5.1.5).
 *
 * Checked over the roster and the ledger *together* rather than each on its own,
 * because the pair that matters is usually one row from each. An escalation
 * settles a day in the ledger — pulling somebody in who was not rostered — while
 * the roster still says what was planned for the day after. Checking the two
 * tables separately sees nothing wrong with either one.
 *
 * Where both tables cover the same day the ledger wins: it is what happened.
 */
function checkConsecutiveDays(roster, ledger, report) {
  var heldBy = {};

  function add(rows, where) {
    rows.forEach(function (r) {
      if (!r.name) return;
      if (!heldBy[r.name]) heldBy[r.name] = {};
      heldBy[r.name][r.date] = { post: r.post, where: where, row: r._row };
    });
  }
  add(roster, TABS.ROSTER);
  add(ledger, TABS.LEDGER);   // second, so a settled day overrides the plan

  Object.keys(heldBy).forEach(function (name) {
    Object.keys(heldBy[name]).forEach(function (date) {
      var next = isoAddDays(date, 1);
      var today = heldBy[name][date];
      var after = heldBy[name][next];
      if (!after) return;
      report(after.where + ' row ' + after.row,
        name + ' is on guard two days running: ' + today.post + ' on ' + date +
        ' (' + today.where + ') and ' + after.post + ' on ' + next +
        ' (' + after.where + ').');
    });
  });
}

/** Menu action: run the checks and show what they found. */
function validateNow() {
  var problems = runValidation();
  var ui = SpreadsheetApp.getUi();

  if (!problems.length) {
    ui.alert('Everything checks out', 'No invariant violations found.', ui.ButtonSet.OK);
    return;
  }

  var lines = problems.slice(0, 40).map(function (p) { return '• ' + p.where + ': ' + p.message; });
  if (problems.length > 40) lines.push('… and ' + (problems.length - 40) + ' more.');

  ui.alert(problems.length + ' problem' + (problems.length === 1 ? '' : 's') + ' found',
    lines.join('\n'), ui.ButtonSet.OK);
}
