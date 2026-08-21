/**
 * Loads the pure Apps Script modules as plain JavaScript so they can be tested
 * in Node.
 *
 * Apps Script has no test runner, and the pure modules deliberately touch no
 * Apps Script global (no SpreadsheetApp, no Utilities), so they are ordinary
 * JavaScript and can be evaluated in a vm context. This is what keeps the
 * scoring, fairness and scheduling logic — the parts that must be correct —
 * under real tests rather than deploy-and-see.
 *
 * Anything that touches the Sheet lives in 40_sheet.gs and above, and is not
 * loaded here.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PURE_FILES = [
  '00_schema.gs',
  '10_scoring.gs',
  '20_fairness.gs',
  '30_scheduler.gs'
];

export function loadPure() {
  const source = PURE_FILES
    .map((file) => fs.readFileSync(path.join(ROOT, 'apps-script', file), 'utf8'))
    .join('\n;\n');

  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: 'psychoco-pure.js' });
  return context;
}

/**
 * Normalise a value returned from the vm context into this realm.
 *
 * Objects built inside the context have that context's Object.prototype, which
 * strict deepEqual treats as a mismatch even when the structure is identical.
 * Round-tripping through JSON gives plain host-realm values to compare against.
 */
export function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/** The placeholder scoring config, parsed into the shape the modules expect. */
export function defaultConfig(psy, overrides = {}) {
  const values = {};
  for (const [key, value] of psy.DEFAULT_CONFIG) values[key] = value;

  const config = {
    version: 1,
    baseH: {
      '1st': psy.toHundredths(values['base.1st']),
      '2nd': psy.toHundredths(values['base.2nd']),
      '3rd': psy.toHundredths(values['base.3rd'])
    },
    multH: {
      weekday: psy.toHundredths(values['mult.weekday']),
      fri: psy.toHundredths(values['mult.fri']),
      sat: psy.toHundredths(values['mult.sat']),
      sun: psy.toHundredths(values['mult.sun']),
      public: psy.toHundredths(values['mult.public']),
      protected: psy.toHundredths(values['mult.protected'])
    },
    absence: {
      minRecalibratingDays: values['absence.minRecalibratingDays']
    },
    caps: {
      shiftsPerWeek: values['cap.shiftsPerWeek'],
      shiftsPerMonth: values['cap.shiftsPerMonth'],
      minWeekendGapDays: values['cap.minWeekendGapDays']
    },
    weights: {
      categoryParity: values['weight.categoryParity'],
      spacing: values['weight.spacing']
    },
    search: {
      iterations: values['search.iterations'],
      seed: values['search.seed']
    }
  };

  return deepMerge(config, overrides);
}

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const key of Object.keys(extra)) {
    const value = extra[key];
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? deepMerge(base[key] ?? {}, value)
      : value;
  }
  return out;
}

/** A pool of interchangeable people, all present for the whole period. */
export function pool(count, periodStart = '2026-10-01') {
  return Array.from({ length: count }, (_, i) => ({
    name: 'P' + String(i + 1).padStart(2, '0'),
    arrival: periodStart,
    departure: null,
    fractionH: 100,
    restrictions: []
  }));
}

export function emptyAbsences(people) {
  const map = {};
  for (const p of people) map[p.name] = [];
  return map;
}
