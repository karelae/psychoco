/**
 * Schema constants and civil-date helpers.
 *
 * PURE: nothing in this file may touch SpreadsheetApp or any other Apps Script
 * global. It is loaded by the Node test harness as plain JavaScript.
 *
 * Dates are ISO civil-date strings ('YYYY-MM-DD') everywhere in the pure
 * modules. A calendar day is a calendar day; no instants, no timezones. The
 * Sheet I/O layer (40_sheet.gs) is the only place that converts to and from
 * Date objects, and it does so in Europe/Brussels.
 *
 * Money-like values (points, multipliers, working fractions) are integer
 * HUNDREDTHS internally. The Sheet stores human decimals; conversion happens
 * on read. Never let a float into a balance.
 */

var POSTS = ['1st', '2nd', '3rd'];

var TABS = {
  PERIOD: 'Period',
  PEOPLE: 'People',
  ABSENCES: 'Absences',
  WORKLOAD: 'Workload',
  HOLIDAYS: 'Holidays',
  CONFIG: 'Config',
  ROSTER: 'Roster',
  LEDGER: 'Ledger',
  ESCALATIONS: 'Escalations',
  AUDIT: 'Audit'
};

var HEADERS = {};
HEADERS[TABS.PERIOD] = ['Start', 'End', 'Operator'];
// Email is optional. When any are filled in, the Web App treats them as the
// viewer allowlist; when the column is empty it falls back to "any signed-in
// Google account with the link" (80_webapp.gs).
HEADERS[TABS.PEOPLE] = ['Name', 'Arrival', 'Departure', 'Fraction', 'Restrictions', 'Email'];
HEADERS[TABS.ABSENCES] = ['Name', 'From', 'To', 'Type', 'Reduces availability'];
// A person's working fraction can change part-way through a period — going half
// time, for instance. One row per span; the People tab's Fraction is the default
// for any date no row covers.
HEADERS[TABS.WORKLOAD] = ['Name', 'From', 'To', 'Fraction', 'Note'];
HEADERS[TABS.HOLIDAYS] = ['Date', 'Kind', 'Label'];
HEADERS[TABS.CONFIG] = ['Version', 'Effective from', 'Key', 'Value', 'Note'];
HEADERS[TABS.ROSTER] = ['Date', 'Post', 'Name', 'Origin', 'Reason'];
HEADERS[TABS.LEDGER] = ['Date', 'Post', 'Name', 'Points', 'Config version'];
HEADERS[TABS.ESCALATIONS] = ['Date', 'Dropped out', 'Chain', 'Backfill', 'Reason'];
HEADERS[TABS.AUDIT] = ['Timestamp', 'Actor', 'Action', 'Detail'];

/** Short weekday names, indexed by isoDayOfWeek. */
var DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Day kinds, and the config key holding each one's multiplier. */
var DAY_KINDS = ['weekday', 'fri', 'sat', 'sun', 'public', 'protected'];

/**
 * Placeholder scoring values (README §2 — the group fixes these before the
 * first roster is generated). Written into the Config tab at setup so the
 * sheet is never empty, and editable there afterwards. Decimals here; the
 * reader converts to hundredths.
 */
var DEFAULT_CONFIG = [
  ['base.1st', 6, 'Points for a first call before the day-type multiplier'],
  ['base.2nd', 3, 'Points for a second call before the day-type multiplier'],
  ['base.3rd', 1, 'Points for a third call before the day-type multiplier'],
  ['mult.weekday', 1.0, 'Monday to Thursday'],
  ['mult.fri', 1.2, 'Friday'],
  ['mult.sat', 1.5, 'Saturday'],
  ['mult.sun', 1.5, 'Sunday'],
  ['mult.public', 1.8, 'Public holiday'],
  ['mult.protected', 2.2, 'Protected holiday (24/25 Dec, 31 Dec, 1 Jan)'],
  ['absence.minRecalibratingDays', 14, 'Shortest absence that lowers a person’s expected share (README §3.1.1)'],
  ['cap.shiftsPerWeek', 3, 'Hard constraint: most posts one person may hold in any 7 days'],
  ['cap.shiftsPerMonth', 8, 'Hard constraint: most posts one person may hold in a calendar month'],
  ['cap.minWeekendGapDays', 14, 'Hard constraint: minimum days between two weekend posts'],
  ['weight.categoryParity', 1, 'Soft objective weight: evenness of weekend/holiday/1st counts'],
  ['weight.spacing', 1, 'Soft objective weight: spreading a person’s posts apart'],
  ['search.iterations', 20000, 'Local-search moves attempted per generation'],
  ['search.seed', 1, 'Fixed seed — generation must be reproducible']
];

// ---------------------------------------------------------------------------
// Civil-date helpers
// ---------------------------------------------------------------------------

/** Parse 'YYYY-MM-DD' into {y, m, d}. Throws on anything else. */
function isoParts(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (!m) throw new Error('Not an ISO civil date: ' + iso);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** Days since epoch for a civil date. UTC arithmetic only, so no DST drift. */
function isoToDayNumber(iso) {
  var p = isoParts(iso);
  return Math.floor(Date.UTC(p.y, p.m - 1, p.d) / 86400000);
}

function dayNumberToIso(n) {
  var dt = new Date(n * 86400000);
  var mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  var dd = String(dt.getUTCDate()).padStart(2, '0');
  return dt.getUTCFullYear() + '-' + mm + '-' + dd;
}

function isoAddDays(iso, n) {
  return dayNumberToIso(isoToDayNumber(iso) + n);
}

/** 0 = Sunday, 1 = Monday, ... 6 = Saturday. */
function isoDayOfWeek(iso) {
  var p = isoParts(iso);
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
}

/** Inclusive list of ISO dates from `from` to `to`. */
function isoRange(from, to) {
  var out = [];
  var a = isoToDayNumber(from);
  var b = isoToDayNumber(to);
  for (var n = a; n <= b; n++) out.push(dayNumberToIso(n));
  return out;
}

/** Inclusive day count between two ISO dates; 0 if the range is inverted. */
function isoDaysBetween(from, to) {
  var n = isoToDayNumber(to) - isoToDayNumber(from) + 1;
  return n > 0 ? n : 0;
}

/** Every date in a calendar month, e.g. monthDates(2026, 10). */
function monthDates(year, month) {
  var first = year + '-' + String(month).padStart(2, '0') + '-01';
  var nextMonthFirst = month === 12
    ? (year + 1) + '-01-01'
    : year + '-' + String(month + 1).padStart(2, '0') + '-01';
  return isoRange(first, isoAddDays(nextMonthFirst, -1));
}

/** The 1 Oct – 30 Sep period containing a given date (README §4). */
function periodFor(iso) {
  var p = isoParts(iso);
  var startYear = p.m >= 10 ? p.y : p.y - 1;
  return { start: startYear + '-10-01', end: (startYear + 1) + '-09-30' };
}

// ---------------------------------------------------------------------------
// Fixed-point helpers
// ---------------------------------------------------------------------------

/** Sheet decimal -> integer hundredths. Math.round makes 1.5 -> 150 exactly. */
function toHundredths(value) {
  var n = Number(value);
  if (!isFinite(n)) throw new Error('Not a number: ' + value);
  return Math.round(n * 100);
}

/** Integer hundredths -> decimal, for display and for writing to the Sheet. */
function fromHundredths(h) {
  return Math.round(Number(h)) / 100;
}

/** Deterministic RNG. Generation must be reproducible from its seed. */
function mulberry32(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
