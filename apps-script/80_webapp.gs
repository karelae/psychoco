/**
 * The read-only board the group sees.
 *
 * The Sheet itself is shared with nobody but the operator. Everyone else gets
 * this Web App, which is read-only by construction and decides what is shown.
 * That solves two things at once: nobody can edit the ledger, and the group
 * never sees individual absence records — only a derived count of available
 * days (README §7.1).
 *
 * Deployed with "Execute as: me" so it can read a Sheet the viewer cannot.
 * Which makes the allowlist below the actual access control.
 */

function doGet() {
  var gate = checkViewer();
  if (!gate.allowed) {
    return HtmlService.createHtmlOutput(
      '<p style="font-family:system-ui;padding:2rem">Psychoco is not shared with ' +
      escapeHtml(gate.email || 'this account') + '.</p>'
    );
  }

  var template = HtmlService.createTemplateFromFile('board');
  template.data = JSON.stringify(buildBoardData(gate.email));
  return template.evaluate()
    .setTitle('Psychoco')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** The same board, in a dialog, for the operator. */
function showBoard() {
  var template = HtmlService.createTemplateFromFile('board');
  template.data = JSON.stringify(buildBoardData(''));
  SpreadsheetApp.getUi().showModalDialog(
    template.evaluate().setWidth(900).setHeight(700),
    'Psychoco'
  );
}

/**
 * Access control. If any email is filled in on the People tab, only those
 * addresses may read the board. If the column is empty, any signed-in Google
 * account with the link may — which is the weaker default, and why SETUP.md
 * asks for the emails.
 */
function checkViewer() {
  var email = '';
  try {
    email = (Session.getActiveUser().getEmail() || '').toLowerCase();
  } catch (e) {
    email = '';
  }

  var allowed = [];
  try {
    readPeople().forEach(function (p) { if (p.email) allowed.push(p.email); });
    var operator = (readPeriod().operator || '').toLowerCase();
    if (operator.indexOf('@') > -1) allowed.push(operator);
  } catch (e) {
    return { allowed: false, email: email };
  }

  if (!allowed.length) return { allowed: true, email: email };
  return { allowed: allowed.indexOf(email) > -1, email: email };
}

/**
 * Everything the board renders. Note what is *not* here: no absence rows, no
 * absence reasons, no email addresses. Availability leaves this function only
 * as a day count.
 */
function buildBoardData(viewerEmail) {
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var model = readModel(today);

  var board = computeBalances(
    model.people, model.absencesByName, model.ledger, model.period.start, today,
    model.fractionSpansByName
  );

  var emailToName = {};
  model.people.forEach(function (p) { if (p.email) emailToName[p.email] = p.name; });

  var rows = board.rows.map(function (r) {
    return {
      name: r.name,
      availableDays: Math.round(r.availH / 100),
      points: fromHundredths(r.pointsH),
      expected: fromHundredths(r.expectedH),
      balance: fromHundredths(r.balanceH),
      rate: fromHundredths(r.rateH)
    };
  });

  var upcoming = upcomingCalendar(model, today, 150);

  return {
    period: { start: model.period.start, end: model.period.end, operator: model.period.operator },
    today: today,
    you: emailToName[(viewerEmail || '').toLowerCase()] || null,
    targetRate: fromHundredths(board.targetRateH),
    totalPoints: fromHundredths(board.totalPointsH),
    configVersion: model.config.version,
    scoring: {
      base: {
        '1st': fromHundredths(model.config.baseH['1st']),
        '2nd': fromHundredths(model.config.baseH['2nd']),
        '3rd': fromHundredths(model.config.baseH['3rd'])
      },
      multipliers: DAY_KINDS.reduce(function (acc, kind) {
        acc[kind] = fromHundredths(model.config.multH[kind]);
        return acc;
      }, {})
    },
    rows: rows,
    upcoming: upcoming
  };
}

var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/**
 * The roster grouped into calendar months, one entry per day with all three
 * posts on it.
 *
 * A day is the unit people think in — "who is on on Saturday" — and a month grid
 * is how they expect to read a rota. A flat list of a hundred rows is technically
 * the same information and unusable.
 */
function upcomingCalendar(model, fromIso, maxDays) {
  var byDate = {};
  var dates = [];

  model.roster.forEach(function (r) {
    if (r.date < fromIso) return;
    if (!byDate[r.date]) { byDate[r.date] = {}; dates.push(r.date); }
    byDate[r.date][r.post] = r.name;
  });
  dates.sort();
  dates = dates.slice(0, maxDays);

  var months = [];
  var index = {};

  dates.forEach(function (iso) {
    var key = iso.slice(0, 7);
    if (index[key] === undefined) {
      index[key] = months.length;
      months.push({
        key: key,
        label: MONTH_NAMES[Number(iso.slice(5, 7)) - 1] + ' ' + iso.slice(0, 4),
        days: []
      });
    }
    var holiday = isHolidayDay(iso, model.holidayKindByDate);
    months[index[key]].days.push({
      date: iso,
      dom: Number(iso.slice(8, 10)),
      // Monday-first, which is how a Belgian calendar reads.
      weekday: (isoDayOfWeek(iso) + 6) % 7,
      label: holiday ? 'holiday' : (isHeavyDay(iso, model.holidayKindByDate) ? 'weekend' : ''),
      heavy: isHeavyDay(iso, model.holidayKindByDate),
      posts: byDate[iso]
    });
  });

  return { months: months, weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] };
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
