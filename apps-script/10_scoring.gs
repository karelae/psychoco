/**
 * Scoring: points = base(post) x multiplier(day type).
 *
 * PURE. See README §2 for the policy this implements, and TECHNICAL-README §3.4
 * for why every value here is integer hundredths.
 */

/** Posts a person must be able to hold in order to hold this one (README §5.1). */
var POST_RANK = { '1st': 1, '2nd': 2, '3rd': 3 };

/**
 * Every day kind that applies to a date. A date can match more than one — a
 * Sunday that is also a public holiday matches both — which is exactly why the
 * multiplier is chosen by maximum rather than by precedence.
 */
function applicableDayKinds(iso, holidayKindByDate) {
  var kinds = [];
  var dow = isoDayOfWeek(iso);
  if (dow === 6) kinds.push('sat');
  else if (dow === 0) kinds.push('sun');
  else if (dow === 5) kinds.push('fri');
  else kinds.push('weekday');

  var holiday = holidayKindByDate[iso];
  if (holiday === 'public') kinds.push('public');
  if (holiday === 'protected') kinds.push('protected');
  return kinds;
}

/**
 * The applicable multiplier, in hundredths.
 *
 * README §2.2: multipliers never compound — the highest applicable one wins
 * outright. Taking the maximum implements that literally, so the rule stays
 * true even if the group later sets a public holiday lower than a Sunday.
 */
function multiplierFor(iso, holidayKindByDate, config) {
  var kinds = applicableDayKinds(iso, holidayKindByDate);
  var bestKind = kinds[0];
  var bestH = config.multH[bestKind];
  if (bestH === undefined) throw new Error('No multiplier configured for day kind: ' + bestKind);

  for (var i = 1; i < kinds.length; i++) {
    var h = config.multH[kinds[i]];
    if (h === undefined) throw new Error('No multiplier configured for day kind: ' + kinds[i]);
    if (h > bestH) { bestH = h; bestKind = kinds[i]; }
  }
  return { multH: bestH, kind: bestKind, applicable: kinds };
}

/** Points for holding `post` on `iso`, in hundredths. */
function pointsFor(post, iso, holidayKindByDate, config) {
  return priceExplain(post, iso, holidayKindByDate, config).pointsH;
}

/**
 * Points plus the workings. Every price must be explainable (README §5.2), so
 * the parts are returned rather than reconstructed later.
 */
function priceExplain(post, iso, holidayKindByDate, config) {
  var baseH = config.baseH[post];
  if (baseH === undefined) throw new Error('No base weight configured for post: ' + post);

  var m = multiplierFor(iso, holidayKindByDate, config);
  // baseH and multH are both hundredths, so their product is ten-thousandths.
  var pointsH = Math.round((baseH * m.multH) / 100);

  return {
    pointsH: pointsH,
    baseH: baseH,
    multH: m.multH,
    dayKind: m.kind,
    applicableKinds: m.applicable,
    configVersion: config.version,
    text: post + ' on ' + iso + ' (' + m.kind + '): ' +
          fromHundredths(baseH) + ' x ' + fromHundredths(m.multH) +
          ' = ' + fromHundredths(pointsH)
  };
}

/** True when `iso` carries a weekend or holiday multiplier — used for parity. */
function isHeavyDay(iso, holidayKindByDate) {
  var kinds = applicableDayKinds(iso, holidayKindByDate);
  for (var i = 0; i < kinds.length; i++) {
    if (kinds[i] === 'sat' || kinds[i] === 'sun' ||
        kinds[i] === 'public' || kinds[i] === 'protected') return true;
  }
  return false;
}

function isHolidayDay(iso, holidayKindByDate) {
  var h = holidayKindByDate[iso];
  return h === 'public' || h === 'protected';
}

/**
 * Whether a person may hold a post at all.
 *
 * README §5.1: because the chain shifts up on a drop-out, holding 3rd means
 * being able to run a 2nd and a 1st. So a restriction on a heavier post also
 * disqualifies someone from every lighter one.
 */
function mayHoldPost(person, post) {
  var restrictions = person.restrictions || [];
  var rank = POST_RANK[post];
  if (rank === undefined) throw new Error('Unknown post: ' + post);

  for (var i = 0; i < restrictions.length; i++) {
    var restrictedRank = POST_RANK[restrictions[i]];
    if (restrictedRank === undefined) continue;
    if (restrictedRank <= rank) return false;
  }
  return true;
}

/**
 * Whether a person can hold any post at all.
 *
 * Because a restriction on a heavier post rules out the lighter ones,
 * "cannot run a 1st" means "cannot be on the rota" — there is no post left. Such
 * a person must be excluded from the fairness denominator entirely (see
 * availableDayHundredths), or they accrue a deficit nobody can ever repay while
 * shrinking everyone else's expected share.
 */
function canHoldAnyPost(person) {
  for (var i = 0; i < POSTS.length; i++) {
    if (mayHoldPost(person, POSTS[i])) return true;
  }
  return false;
}

/** Total points a set of slots is worth — the denominator side of fairness. */
function priceSlots(slots, holidayKindByDate, config) {
  var total = 0;
  for (var i = 0; i < slots.length; i++) {
    total += pointsFor(slots[i].post, slots[i].date, holidayKindByDate, config);
  }
  return total;
}
