/**
 * The operator's interface: everything they need to run a period, as menu
 * items. README §7 — no config files, no script editor, no tribal knowledge.
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Psychoco')
    .addItem('Open the board', 'showBoard')
    .addSeparator()
    .addItem('Generate roster for a month…', 'generateMonth')
    .addItem('Publish a month to the ledger…', 'publishMonth')
    .addItem('Record a drop-out…', 'recordDropout')
    .addSeparator()
    .addItem('Explain an assignment…', 'explainSlot')
    .addItem('Check for problems', 'validateNow')
    .addSeparator()
    .addItem('Set up workbook…', 'setUpWorkbook')
    .addToUi();
}

function promptMonth(ui, title) {
  var answer = ui.prompt(title, 'Which month? Use YYYY-MM, for example 2026-10.', ui.ButtonSet.OK_CANCEL);
  if (answer.getSelectedButton() !== ui.Button.OK) return null;
  var text = answer.getResponseText().trim();
  if (!/^\d{4}-\d{2}$/.test(text)) {
    ui.alert('That is not a month. Use YYYY-MM, for example 2026-10.');
    return null;
  }
  var year = Number(text.slice(0, 4));
  var month = Number(text.slice(5, 7));
  if (month < 1 || month > 12) {
    ui.alert('There is no month ' + month + '.');
    return null;
  }
  return { text: text, dates: monthDates(year, month) };
}

/**
 * Generate a month's roster.
 *
 * Monthly rather than annual: absences are not known a year ahead, and
 * rebalancing every month is what makes the balance hold continuously rather
 * than only at the end of the period (README §4).
 */
function generateMonth() {
  var ui = SpreadsheetApp.getUi();
  var month = promptMonth(ui, 'Generate a roster');
  if (!month) return;

  var model = readModel(month.dates[0]);
  var existing = model.roster.filter(function (r) {
    return r.date >= month.dates[0] && r.date <= month.dates[month.dates.length - 1];
  });

  if (existing.length) {
    var confirm = ui.alert(
      'Replace the existing roster?',
      month.text + ' already has ' + existing.length + ' assignments.\n\n' +
      'Generating again will delete and replace all of them, including any manual overrides. ' +
      'The ledger is not touched.',
      ui.ButtonSet.YES_NO
    );
    if (confirm !== ui.Button.YES) return;
  }

  var result;
  try {
    result = generateRoster({
      dates: month.dates,
      people: model.people,
      absencesByName: model.absencesByName,
      fractionSpansByName: model.fractionSpansByName,
      holidayKindByDate: model.holidayKindByDate,
      config: model.config,
      priorDuties: model.ledger,
      priorAssignments: model.roster,
      period: model.period
    });
  } catch (e) {
    if (e.name === 'SchedulingError') {
      var blockers = e.detail && e.detail.blockers ? e.detail.blockers : {};
      var why = Object.keys(blockers).slice(0, 15).map(function (n) {
        return '• ' + n + ': ' + blockers[n];
      });
      ui.alert(
        'Cannot produce a complete roster',
        e.message + '\n\nWhy each person was unavailable:\n' + why.join('\n') +
        '\n\nNothing has been changed. Coverage is a hard constraint, so no partial ' +
        'roster is written — fix the cause and generate again.',
        ui.ButtonSet.OK
      );
      return;
    }
    throw e;
  }

  replaceRosterForDates(month.dates, result.assignments);
  audit('generateMonth', month.text + ': ' + result.assignments.length + ' assignments, config v' +
    model.config.version + ', ' + result.movesAccepted + ' improving swaps of ' + result.movesTried +
    ' tried, objective ' + result.objectiveBefore.toFixed(1) + ' → ' + result.objectiveAfter.toFixed(1));

  ui.alert(
    'Roster generated for ' + month.text,
    result.assignments.length + ' posts filled.\n\n' +
    'Balance objective improved from ' + result.objectiveBefore.toFixed(1) +
    ' to ' + result.objectiveAfter.toFixed(1) + '.\n' +
    'Priced under config version ' + model.config.version + '.\n\n' +
    'Nothing is credited yet — points only count once the month is published to the ledger.',
    ui.ButtonSet.OK
  );
}

/**
 * Copy a month's roster into the ledger, pricing each duty.
 *
 * The ledger is what actually happened (TECHNICAL-README §2.1), so this is the
 * step that credits points. Dates already in the ledger are skipped, which is
 * what protects drop-out days that were settled on the day.
 */
function publishMonth() {
  var ui = SpreadsheetApp.getUi();
  var month = promptMonth(ui, 'Publish a month to the ledger');
  if (!month) return;

  var model = readModel(month.dates[0]);
  var inMonth = {};
  month.dates.forEach(function (d) { inMonth[d] = true; });

  var alreadyLedgered = {};
  model.ledger.forEach(function (r) {
    if (inMonth[r.date]) alreadyLedgered[r.date] = true;
  });

  var toWrite = [];
  var skipped = 0;
  model.roster.forEach(function (r) {
    if (!inMonth[r.date]) return;
    if (alreadyLedgered[r.date]) { skipped++; return; }
    toWrite.push({
      date: r.date,
      post: r.post,
      name: r.name,
      pointsH: pointsFor(r.post, r.date, model.holidayKindByDate, model.config),
      configVersion: model.config.version
    });
  });

  if (!toWrite.length) {
    ui.alert('Nothing to publish',
      'Every rostered day in ' + month.text + ' is already in the ledger.', ui.ButtonSet.OK);
    return;
  }

  var totalH = toWrite.reduce(function (acc, r) { return acc + r.pointsH; }, 0);
  var confirm = ui.alert(
    'Publish ' + month.text + ' to the ledger?',
    toWrite.length + ' duties, worth ' + fromHundredths(totalH) + ' points in total.\n' +
    (skipped ? skipped + ' rows skipped — those days are already in the ledger.\n' : '') +
    '\nThis credits points and changes everyone’s balance.',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  appendLedger(toWrite);
  audit('publishMonth', month.text + ': ' + toWrite.length + ' duties, ' +
    fromHundredths(totalH) + ' points, config v' + model.config.version);

  ui.alert('Published', toWrite.length + ' duties credited for ' + month.text + '.', ui.ButtonSet.OK);
}

/**
 * Record a drop-out: shift the chain up, find a backfill, settle the day.
 *
 * README §1.2 and §2.4 — the 2nd becomes 1st, the 3rd becomes 2nd, someone new
 * comes in at 3rd, and points follow the post actually worked. The day is
 * written straight to the ledger because the truth is known immediately.
 */
function recordDropout() {
  var ui = SpreadsheetApp.getUi();

  var dateAnswer = ui.prompt('Record a drop-out', 'Which day? Use YYYY-MM-DD.', ui.ButtonSet.OK_CANCEL);
  if (dateAnswer.getSelectedButton() !== ui.Button.OK) return;
  var date;
  try {
    date = asIso(dateAnswer.getResponseText().trim());
  } catch (e) {
    ui.alert(String(e.message || e));
    return;
  }

  var model = readModel(date);
  var today = model.roster.filter(function (r) { return r.date === date; });
  if (!today.length) {
    ui.alert('Nothing rostered on ' + date + '.');
    return;
  }
  today.sort(function (a, b) { return POST_RANK[a.post] - POST_RANK[b.post]; });

  var who = ui.prompt(
    'Who dropped out?',
    'Rostered on ' + date + ':\n' +
    today.map(function (r) { return '  ' + r.post + ': ' + r.name; }).join('\n') +
    '\n\nType the name of the person who dropped out.',
    ui.ButtonSet.OK_CANCEL
  );
  if (who.getSelectedButton() !== ui.Button.OK) return;
  var dropper = who.getResponseText().trim();

  var dropIndex = -1;
  for (var i = 0; i < today.length; i++) if (today[i].name === dropper) dropIndex = i;
  if (dropIndex < 0) {
    ui.alert(dropper + ' is not rostered on ' + date + '.');
    return;
  }

  // Everyone below the drop-out moves up one post.
  var worked = [];
  for (var p = dropIndex; p < today.length - 1; p++) {
    worked.push({ post: today[p].post, name: today[p + 1].name });
  }
  for (var q = 0; q < dropIndex; q++) {
    worked.push({ post: today[q].post, name: today[q].name });
  }
  var vacantPost = today[today.length - 1].post;

  // Rank the shortlist for the vacant post exactly as the scheduler would.
  var rosterMinusToday = model.roster.filter(function (r) { return r.date !== date; });
  var shortlist;
  try {
    var explained = explainAssignment({
      dates: [date],
      people: model.people,
      absencesByName: model.absencesByName,
      fractionSpansByName: model.fractionSpansByName,
      holidayKindByDate: model.holidayKindByDate,
      config: model.config,
      priorDuties: model.ledger,
      priorAssignments: rosterMinusToday.concat(worked.map(function (w) {
        return { date: date, post: w.post, name: w.name };
      })),
      period: model.period
    }, date, vacantPost);
    shortlist = explained.eligible.slice(0, 8);
  } catch (e) {
    shortlist = [];
  }

  var chainText = worked.map(function (w) { return w.name + ' → ' + w.post; }).join(', ');
  var pick = ui.prompt(
    'Who came in at ' + vacantPost + '?',
    'Chain shift on ' + date + ': ' + chainText + '\n\n' +
    'Most owed and available for ' + vacantPost + ':\n' +
    (shortlist.length
      ? shortlist.map(function (c, idx) {
          return '  ' + (idx + 1) + '. ' + c.name + '  (balance ' + fromHundredths(c.deficitH) + ')';
        }).join('\n')
      : '  nobody is both available and cleared — check absences') +
    '\n\nType the name of whoever actually took it, or leave blank if the post went uncovered.',
    ui.ButtonSet.OK_CANCEL
  );
  if (pick.getSelectedButton() !== ui.Button.OK) return;
  var backfill = pick.getResponseText().trim();
  if (backfill) worked.push({ post: vacantPost, name: backfill });

  var rows = worked.map(function (w) {
    return {
      date: date,
      post: w.post,
      name: w.name,
      pointsH: pointsFor(w.post, date, model.holidayKindByDate, model.config),
      configVersion: model.config.version
    };
  });

  var summary = rows.map(function (r) {
    return '  ' + r.post + ': ' + r.name + '  (' + fromHundredths(r.pointsH) + ')';
  }).join('\n');

  var confirm = ui.alert(
    'Settle ' + date + '?',
    'Credited to the ledger:\n' + summary + '\n\n' +
    dropper + ' is credited nothing, and the day is recorded as an absence so their ' +
    'expected share drops with it.\n\n' +
    (backfill ? '' : 'Warning: ' + vacantPost + ' is being recorded as uncovered.\n\n') +
    'This is the record of what actually happened and it changes balances.',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  appendLedger(rows);
  appendEscalation({
    date: date,
    droppedOut: dropper,
    chain: chainText,
    backfill: backfill || '(uncovered)',
    reason: 'drop-out recorded by the operator'
  });
  appendAbsence({ name: dropper, from: date, to: date, type: 'drop-out', reduces: true });
  audit('recordDropout', date + ': ' + dropper + ' dropped out; ' + chainText +
    '; ' + vacantPost + ' → ' + (backfill || 'uncovered'));

  ui.alert('Recorded', date + ' is settled in the ledger.', ui.ButtonSet.OK);
}

/** Why this person, for one slot (README §5.2). */
function explainSlot() {
  var ui = SpreadsheetApp.getUi();
  var answer = ui.prompt('Explain an assignment',
    'Which slot? Use YYYY-MM-DD and the post, for example: 2026-12-25 1st',
    ui.ButtonSet.OK_CANCEL);
  if (answer.getSelectedButton() !== ui.Button.OK) return;

  var parts = answer.getResponseText().trim().split(/\s+/);
  if (parts.length < 2) { ui.alert('Use the form: 2026-12-25 1st'); return; }
  var date = asIso(parts[0]);
  var post = parts[1];

  var model = readModel(date);
  var current = model.roster.filter(function (r) { return r.date === date && r.post === post; })[0];

  var explained = explainAssignment({
    dates: [date],
    people: model.people,
    absencesByName: model.absencesByName,
    fractionSpansByName: model.fractionSpansByName,
    holidayKindByDate: model.holidayKindByDate,
    config: model.config,
    priorDuties: model.ledger,
    priorAssignments: model.roster,
    period: model.period
  }, date, post);

  var eligible = explained.eligible.slice(0, 10).map(function (c) {
    return '  ' + c.name + ': balance ' + fromHundredths(c.deficitH) +
      (current && c.name === current.name ? '   ← rostered' : '');
  });
  var blocked = explained.blocked.slice(0, 12).map(function (b) {
    return '  ' + b.name + ': ' + b.reason;
  });

  ui.alert(
    post + ' on ' + date,
    explained.price.text + '\n\n' +
    'Rostered: ' + (current ? current.name : 'nobody') + '\n\n' +
    'Most owed among those who could take it:\n' + (eligible.join('\n') || '  nobody') + '\n\n' +
    'Ruled out (' + explained.blocked.length + '):\n' + (blocked.join('\n') || '  nobody'),
    ui.ButtonSet.OK
  );
}
