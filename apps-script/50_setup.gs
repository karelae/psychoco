/**
 * Builds the workbook.
 *
 * README §7 requires starting a period to be a guided task rather than manual
 * spreadsheet surgery, because the operator is untrained and changes every
 * year. So the structure is created by code: tabs, headers, dropdowns,
 * validation and protected ranges all come from here, and a fresh period is one
 * menu item.
 */

function setUpWorkbook() {
  var ui = SpreadsheetApp.getUi();
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var period = periodFor(today);

  var answer = ui.prompt(
    'Set up Psychoco',
    'This creates any missing tabs and seeds the scoring config.\n\n' +
    'Which period is this? Enter the starting year (1 October):',
    ui.ButtonSet.OK_CANCEL
  );
  if (answer.getSelectedButton() !== ui.Button.OK) return;

  var year = Number(answer.getResponseText().trim() || period.start.slice(0, 4));
  if (!isFinite(year) || year < 2000 || year > 2100) {
    ui.alert('That does not look like a year.');
    return;
  }
  var start = year + '-10-01';
  var end = (year + 1) + '-09-30';

  var created = [];
  Object.keys(TABS).forEach(function (key) {
    var name = TABS[key];
    if (ensureTab(name)) created.push(name);
  });

  seedPeriod(start, end);
  var configSeeded = seedConfig(start);
  applyValidation();
  protectDerivedTabs();

  audit('setUpWorkbook', 'period ' + start + ' to ' + end +
    (created.length ? '; created tabs: ' + created.join(', ') : '; all tabs already present') +
    (configSeeded ? '; seeded config v1' : '; config left as-is'));

  ui.alert(
    'Psychoco is set up',
    'Period: ' + start + ' to ' + end + '\n\n' +
    (created.length ? 'Created: ' + created.join(', ') + '\n\n' : '') +
    'Next steps:\n' +
    '1. Fill in the People tab.\n' +
    '2. Fill in the Holidays tab for this period.\n' +
    '3. Check the placeholder weights on the Config tab — the group must agree them.\n' +
    '4. Psychoco → Generate roster for a month.',
    ui.ButtonSet.OK
  );
}

/** Create a tab with headers if missing. Returns true when it was created. */
function ensureTab(name) {
  var ss = book();
  var sheet = ss.getSheetByName(name);
  var created = false;
  if (!sheet) {
    sheet = ss.insertSheet(name);
    created = true;
  }

  var headers = HEADERS[name];
  var current = sheet.getRange(1, 1, 1, headers.length).getValues()[0].map(asText);
  var matches = current.join('|') === headers.join('|');
  if (!matches) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#efefef');
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
  return created;
}

function seedPeriod(start, end) {
  var sheet = tab(TABS.PERIOD);
  var operator = '';
  if (sheet.getLastRow() >= 2) operator = asText(sheet.getRange(2, 3).getValue());
  sheet.getRange(2, 1, 1, 3).setValues([[start, end, operator]]);
  sheet.getRange(2, 1, 1, 2).setNumberFormat('yyyy-mm-dd');
}

/** Seed the placeholder scoring config, but never overwrite existing values. */
function seedConfig(effectiveFrom) {
  var sheet = tab(TABS.CONFIG);
  if (sheet.getLastRow() >= 2) return false;

  var rows = DEFAULT_CONFIG.map(function (entry) {
    return [1, effectiveFrom, entry[0], entry[1], entry[2]];
  });
  sheet.getRange(2, 1, rows.length, 5).setValues(rows);
  sheet.getRange(2, 2, rows.length, 1).setNumberFormat('yyyy-mm-dd');
  return true;
}

/**
 * Dropdowns and type checks. The operator meets a grid rather than a form, so
 * this is the only thing standing between a typo and a wrong ledger
 * (TECHNICAL-README §2 on what a spreadsheet cannot enforce).
 */
function applyValidation() {
  var postRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(POSTS, true)
    .setAllowInvalid(false)
    .setHelpText('Must be 1st, 2nd or 3rd.')
    .build();

  var kindRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['public', 'protected'], true)
    .setAllowInvalid(false)
    .setHelpText('Public holiday, or protected (24/25 Dec, 31 Dec, 1 Jan).')
    .build();

  var dateRule = SpreadsheetApp.newDataValidation()
    .requireDate()
    .setAllowInvalid(false)
    .setHelpText('Must be a date.')
    .build();

  var boolRule = SpreadsheetApp.newDataValidation().requireCheckbox().build();

  var LAST = 2000;

  // Names are validated against the People tab, so a misspelling is rejected
  // rather than quietly becoming a fourth colleague.
  var nameRange = tab(TABS.PEOPLE).getRange('A2:A' + LAST);
  var nameRule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(nameRange, true)
    .setAllowInvalid(false)
    .setHelpText('Must be a name from the People tab.')
    .build();

  tab(TABS.PEOPLE).getRange('B2:C' + LAST).setDataValidation(dateRule).setNumberFormat('yyyy-mm-dd');

  var absences = tab(TABS.ABSENCES);
  absences.getRange('A2:A' + LAST).setDataValidation(nameRule);
  absences.getRange('B2:C' + LAST).setDataValidation(dateRule).setNumberFormat('yyyy-mm-dd');
  absences.getRange('E2:E' + LAST).setDataValidation(boolRule);

  var workload = tab(TABS.WORKLOAD);
  workload.getRange('A2:A' + LAST).setDataValidation(nameRule);
  workload.getRange('B2:C' + LAST).setDataValidation(dateRule).setNumberFormat('yyyy-mm-dd');
  workload.getRange('D2:D' + LAST).setNumberFormat('0.00');

  var holidays = tab(TABS.HOLIDAYS);
  holidays.getRange('A2:A' + LAST).setDataValidation(dateRule).setNumberFormat('yyyy-mm-dd');
  holidays.getRange('B2:B' + LAST).setDataValidation(kindRule);

  var roster = tab(TABS.ROSTER);
  roster.getRange('A2:A' + LAST).setNumberFormat('yyyy-mm-dd');
  roster.getRange('B2:B' + LAST).setDataValidation(postRule);
  roster.getRange('C2:C' + LAST).setDataValidation(nameRule);

  var ledger = tab(TABS.LEDGER);
  ledger.getRange('A2:A' + LAST).setNumberFormat('yyyy-mm-dd');
  ledger.getRange('B2:B' + LAST).setDataValidation(postRule);
  ledger.getRange('D2:D' + LAST).setNumberFormat('0.00');
}

/**
 * Warn before edits to the ledger and the audit trail.
 *
 * Warning rather than blocking, deliberately: a genuine correction has to
 * remain possible, and the operator is the only editor anyway. The point is to
 * make an accidental edit to the two tabs that cannot be reconstructed require
 * a conscious click.
 */
function protectDerivedTabs() {
  [TABS.LEDGER, TABS.AUDIT, TABS.ESCALATIONS].forEach(function (name) {
    var sheet = tab(name);
    var existing = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    for (var i = 0; i < existing.length; i++) existing[i].remove();
    sheet.protect()
      .setDescription(name + ' — the record of what actually happened. Edit with care.')
      .setWarningOnly(true);
  });
}
