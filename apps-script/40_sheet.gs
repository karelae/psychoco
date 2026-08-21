/**
 * Sheet I/O. The only file that knows about SpreadsheetApp, Dates, or
 * timezones — everything above it works in ISO civil dates and integer
 * hundredths.
 *
 * Kept thin on purpose: Apps Script has no test runner, so logic that lives
 * here cannot be covered. Anything worth testing belongs in 00-30.
 */

var TZ = 'Europe/Brussels';

function book() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function tab(name) {
  var sheet = book().getSheetByName(name);
  if (!sheet) throw new Error('Missing tab "' + name + '". Run Psychoco → Set up workbook.');
  return sheet;
}

/** A Sheet cell value as an ISO civil date, in Europe/Brussels. */
function asIso(value) {
  if (value === '' || value === null || value === undefined) return null;
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, TZ, 'yyyy-MM-dd');
  }
  var s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  throw new Error('Not a date: "' + s + '". Use YYYY-MM-DD.');
}

function asText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function asBool(value) {
  if (typeof value === 'boolean') return value;
  var s = asText(value).toLowerCase();
  return s === 'true' || s === 'yes' || s === 'y' || s === '1';
}

/** Rows of a tab as objects keyed by header, with the sheet row number kept. */
function readTable(name) {
  var sheet = tab(name);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  var headers = values[0].map(asText);
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var raw = values[r];
    var blank = true;
    for (var c = 0; c < raw.length; c++) if (asText(raw[c]) !== '') { blank = false; break; }
    if (blank) continue;

    var obj = { _row: r + 1 };
    for (var h = 0; h < headers.length; h++) obj[headers[h]] = raw[h];
    rows.push(obj);
  }
  return rows;
}

function readPeriod() {
  var rows = readTable(TABS.PERIOD);
  if (!rows.length) throw new Error('The Period tab is empty. Run Psychoco → Set up workbook.');
  return {
    start: asIso(rows[0]['Start']),
    end: asIso(rows[0]['End']),
    operator: asText(rows[0]['Operator'])
  };
}

function readPeople() {
  return readTable(TABS.PEOPLE).map(function (r) {
    var restrictions = asText(r['Restrictions']);
    return {
      name: asText(r['Name']),
      arrival: asIso(r['Arrival']),
      departure: asIso(r['Departure']),
      fractionH: r['Fraction'] === '' || r['Fraction'] === null || r['Fraction'] === undefined
        ? 100
        : toHundredths(r['Fraction']),
      restrictions: restrictions === '' ? [] : restrictions.split(',').map(function (s) { return s.trim(); }),
      email: asText(r['Email']).toLowerCase(),
      _row: r._row
    };
  }).filter(function (p) { return p.name !== ''; });
}

function readAbsencesByName(people) {
  var byName = {};
  for (var i = 0; i < people.length; i++) byName[people[i].name] = [];

  readTable(TABS.ABSENCES).forEach(function (r) {
    var name = asText(r['Name']);
    if (!name) return;
    if (!byName[name]) byName[name] = [];
    byName[name].push({
      from: asIso(r['From']),
      to: asIso(r['To']) || asIso(r['From']),
      type: asText(r['Type']),
      reduces: asBool(r['Reduces availability']),
      _row: r._row
    });
  });
  return byName;
}

/**
 * Working-fraction spans per person. Empty for almost everybody — the People
 * tab's Fraction covers any date no row mentions.
 */
function readWorkloadSpans(people) {
  var byName = {};
  for (var i = 0; i < people.length; i++) byName[people[i].name] = [];

  readTable(TABS.WORKLOAD).forEach(function (r) {
    var name = asText(r['Name']);
    if (!name) return;
    if (!byName[name]) byName[name] = [];
    byName[name].push({
      from: asIso(r['From']),
      to: asIso(r['To']),
      fractionH: toHundredths(r['Fraction']),
      note: asText(r['Note']),
      _row: r._row
    });
  });
  return byName;
}

function readHolidays() {
  var map = {};
  readTable(TABS.HOLIDAYS).forEach(function (r) {
    var iso = asIso(r['Date']);
    var kind = asText(r['Kind']).toLowerCase();
    if (!iso) return;
    if (kind !== 'public' && kind !== 'protected') {
      throw new Error('Row ' + r._row + ' of Holidays: Kind must be "public" or "protected".');
    }
    map[iso] = kind;
  });
  return map;
}

/**
 * The scoring config in force on `referenceIso`: the highest version whose
 * effective-from date has arrived (TECHNICAL-README §3.1).
 */
function readConfig(referenceIso) {
  var rows = readTable(TABS.CONFIG);
  if (!rows.length) throw new Error('The Config tab is empty. Run Psychoco → Set up workbook.');

  var byVersion = {};
  rows.forEach(function (r) {
    var v = Number(r['Version']);
    if (!isFinite(v)) throw new Error('Row ' + r._row + ' of Config: Version must be a number.');
    if (!byVersion[v]) byVersion[v] = { version: v, effectiveFrom: asIso(r['Effective from']), values: {} };
    byVersion[v].values[asText(r['Key'])] = r['Value'];
  });

  var chosen = null;
  Object.keys(byVersion).forEach(function (key) {
    var candidate = byVersion[key];
    if (candidate.effectiveFrom && referenceIso && candidate.effectiveFrom > referenceIso) return;
    if (!chosen || candidate.version > chosen.version) chosen = candidate;
  });
  if (!chosen) throw new Error('No scoring config is effective on ' + referenceIso + '.');

  return parseConfig(chosen);
}

function parseConfig(raw) {
  var v = raw.values;
  function need(key) {
    if (v[key] === undefined || v[key] === '') throw new Error('Config is missing "' + key + '".');
    return v[key];
  }
  function num(key, fallback) {
    return v[key] === undefined || v[key] === '' ? fallback : Number(v[key]);
  }

  var multH = {};
  for (var i = 0; i < DAY_KINDS.length; i++) {
    multH[DAY_KINDS[i]] = toHundredths(need('mult.' + DAY_KINDS[i]));
  }

  return {
    version: raw.version,
    effectiveFrom: raw.effectiveFrom,
    baseH: {
      '1st': toHundredths(need('base.1st')),
      '2nd': toHundredths(need('base.2nd')),
      '3rd': toHundredths(need('base.3rd'))
    },
    multH: multH,
    absence: {
      minRecalibratingDays: num('absence.minRecalibratingDays', 14)
    },
    caps: {
      shiftsPerWeek: num('cap.shiftsPerWeek', 0),
      shiftsPerMonth: num('cap.shiftsPerMonth', 0),
      minWeekendGapDays: num('cap.minWeekendGapDays', 0)
    },
    weights: {
      categoryParity: num('weight.categoryParity', 1),
      spacing: num('weight.spacing', 1)
    },
    search: {
      iterations: num('search.iterations', 20000),
      seed: num('search.seed', 1)
    }
  };
}

function readRoster() {
  return readTable(TABS.ROSTER).map(function (r) {
    return {
      date: asIso(r['Date']),
      post: asText(r['Post']),
      name: asText(r['Name']),
      origin: asText(r['Origin']),
      reason: asText(r['Reason']),
      _row: r._row
    };
  }).filter(function (r) { return r.date && r.post; });
}

function readLedger() {
  return readTable(TABS.LEDGER).map(function (r) {
    return {
      date: asIso(r['Date']),
      post: asText(r['Post']),
      name: asText(r['Name']),
      pointsH: toHundredths(r['Points']),
      configVersion: Number(r['Config version']),
      _row: r._row
    };
  }).filter(function (r) { return r.date && r.name; });
}

/** Everything the pure modules need, read once. */
function readModel(referenceIso) {
  var period = readPeriod();
  var people = readPeople();
  return {
    period: period,
    people: people,
    absencesByName: readAbsencesByName(people),
    fractionSpansByName: readWorkloadSpans(people),
    holidayKindByDate: readHolidays(),
    config: readConfig(referenceIso || period.start),
    roster: readRoster(),
    ledger: readLedger()
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function appendRows(tabName, rows) {
  if (!rows.length) return;
  var sheet = tab(tabName);
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

/** Replace the roster for a set of dates, leaving the rest of the tab alone. */
function replaceRosterForDates(dates, assignments) {
  var sheet = tab(TABS.ROSTER);
  var inWindow = {};
  for (var i = 0; i < dates.length; i++) inWindow[dates[i]] = true;

  var existing = readRoster();
  for (var r = existing.length - 1; r >= 0; r--) {
    if (inWindow[existing[r].date]) sheet.deleteRow(existing[r]._row);
  }

  appendRows(TABS.ROSTER, assignments.map(function (a) {
    return [a.date, a.post, a.name, a.origin || 'auto', a.reason || ''];
  }));
}

function appendLedger(rows) {
  appendRows(TABS.LEDGER, rows.map(function (r) {
    return [r.date, r.post, r.name, fromHundredths(r.pointsH), r.configVersion];
  }));
}

function appendEscalation(row) {
  appendRows(TABS.ESCALATIONS, [[row.date, row.droppedOut, row.chain, row.backfill, row.reason]]);
}

function appendAbsence(row) {
  appendRows(TABS.ABSENCES, [[row.name, row.from, row.to, row.type, row.reduces]]);
}

/**
 * Audit every mutation (TECHNICAL-README §5). With a shared editor account this
 * is the only record of what happened, so nothing that changes data should
 * skip it.
 */
function audit(action, detail) {
  var actor = 'unknown';
  try {
    actor = Session.getActiveUser().getEmail() || 'unknown';
  } catch (e) {
    actor = 'unknown';
  }
  var operator = '';
  try {
    operator = readPeriod().operator;
  } catch (e) {
    operator = '';
  }
  appendRows(TABS.AUDIT, [[
    Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'),
    actor + (operator ? ' (operator: ' + operator + ')' : ''),
    action,
    detail
  ]]);
}
