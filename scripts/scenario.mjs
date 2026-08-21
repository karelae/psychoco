/**
 * A realistic scenario, shared by the demo and the board preview so the two
 * cannot drift apart.
 *
 * Deliberately awkward: part-timers, late joiners, someone who leaves early,
 * someone cleared for no post, and scattered leave.
 */

import { loadPure, defaultConfig } from '../test/harness.mjs';

export const psy = loadPure();

export const PERIOD = { start: '2026-10-01', end: '2027-09-30' };

// Belgian public holidays in the period, plus the protected days (README §2.2).
export const HOLIDAYS = {
  '2026-11-01': 'public',    '2026-11-11': 'public',
  '2026-12-24': 'protected', '2026-12-25': 'protected',
  '2026-12-31': 'protected', '2027-01-01': 'protected',
  '2027-03-29': 'public',    '2027-05-01': 'public',
  '2027-05-06': 'public',    '2027-05-17': 'public',
  '2027-07-21': 'public',    '2027-08-15': 'public'
};

const FIRST_NAMES = [
  'Amira', 'Bram', 'Camille', 'Dries', 'Elke', 'Farid', 'Gaëlle', 'Hannes',
  'Ines', 'Joris', 'Katrien', 'Lukas', 'Marie', 'Nabil', 'Otto', 'Pieter',
  'Quinten', 'Ruben', 'Sofie', 'Thomas', 'Ulrike', 'Valerie', 'Wout', 'Xenia',
  'Yasmine', 'Zeno', 'Anouk', 'Bart', 'Charlotte', 'Daan', 'Emma', 'Femke',
  'Gilles', 'Hanne', 'Ilias', 'Jonas', 'Karel', 'Lotte', 'Milan', 'Nora'
];

export function buildScenario(months = [[2026, 10], [2026, 11], [2026, 12]]) {
  const config = defaultConfig(psy);

  const people = FIRST_NAMES.map((name, i) => ({
    name,
    arrival: i === 7 ? '2026-11-15' : i === 21 ? '2026-12-01' : PERIOD.start,
    departure: i === 30 ? '2027-02-28' : null,
    fractionH: i === 3 ? 50 : 100,
    restrictions: i === 12 ? ['1st'] : [],
    email: name.toLowerCase() + '@example.org'
  }));

  const absencesByName = {};
  people.forEach((p) => { absencesByName[p.name] = []; });
  absencesByName[people[0].name] = [{ from: '2026-12-21', to: '2027-01-04', reduces: true }];
  absencesByName[people[5].name] = [{ from: '2026-11-02', to: '2026-11-16', reduces: true }];
  absencesByName[people[9].name] = [{ from: '2026-12-24', to: '2026-12-26', reduces: true }];
  absencesByName[people[25].name] = [{ from: '2026-10-06', to: '2026-10-20', reduces: true }];

  // Sofie goes to 80% from February — a span, not a retroactive rewrite.
  const fractionSpansByName = {
    [people[18].name]: [{ from: '2027-02-01', to: PERIOD.end, fractionH: 80 }]
  };

  const ledger = [];
  const roster = [];
  const runs = [];

  for (const [year, month] of months) {
    const dates = psy.monthDates(year, month);
    const started = Date.now();

    const result = psy.generateRoster({
      dates, people, absencesByName, fractionSpansByName,
      holidayKindByDate: HOLIDAYS, config,
      priorDuties: ledger, priorAssignments: roster, period: PERIOD
    });

    // Publishing is what credits points (TECHNICAL-README §2.1).
    result.assignments.forEach((a) => {
      roster.push({ date: a.date, post: a.post, name: a.name });
      ledger.push({
        date: a.date, post: a.post, name: a.name,
        pointsH: a.pointsH, configVersion: config.version
      });
    });

    runs.push({
      label: year + '-' + String(month).padStart(2, '0'),
      dates,
      ms: Date.now() - started,
      result
    });
  }

  const asOf = ledger.reduce((latest, d) => (d.date > latest ? d.date : latest), PERIOD.start);

  return {
    psy, config, people, absencesByName, fractionSpansByName,
    holidays: HOLIDAYS, period: PERIOD, ledger, roster, runs, asOf
  };
}
