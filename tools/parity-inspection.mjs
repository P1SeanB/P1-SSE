// Inspection parity — fire and PM inspection labour.
//
//   npm run parity:inspection
//
// Transcribed independently from calcFireInsp and calcPMInsp in
// legacy/index.html.
//
// THE ASYMMETRY THIS EXISTS FOR. Extra technicians are applied differently in the
// two calculations, and the difference is not obvious enough to survive a rewrite by
// inspection:
//
//   fire   totalHrs = (annual x techs) + semiAnnual + pm
//   PM     totalHrs = (devices + extra) x techs
//
// On a fire inspection extra technicians repeat the ANNUAL visit only — the
// semi-annual and PM visits are single-tech work. On a PM they multiply everything.
// Applying the fire rule to a PM undercharges every multi-tech PM agreement; applying
// the PM rule to a fire inspection overcharges every multi-tech fire inspection. Both
// look reasonable and neither announces itself.
import { calcFireInspection, calcPmInspection, roundTo4 } from '../src/lib/calc.js';

const LABOR_COST = 48;
const BILL_RATE = 145;

// ── Legacy transcription ────────────────────────────────────────────────────
const r4 = (v) => (v === 0 ? 0 : Math.ceil(v / 4) * 4);

function legacyFire(rows, pmHrs, techs, laborCostPerHr, lRate) {
  let annualHrs = 0, semiHrs = 0;
  rows.forEach((r) => {
    const count = parseFloat(r.count) || 0;
    const rateHrs = parseFloat(r.hrs) || 0;
    const rateMins = parseFloat(r.mins) || 0;
    const hrs = count * (rateHrs + rateMins / 60);
    annualHrs += hrs;
    if (r.semi) semiHrs += hrs;
  });
  const annualHrsR = r4(annualHrs);
  const semiHrsR = r4(semiHrs);
  const pmHrsR = r4(parseFloat(pmHrs) || 0);
  const fiTechs = Math.max(1, parseFloat(techs) || 1);
  const totalHrs = (annualHrsR * fiTechs) + semiHrsR + pmHrsR;
  return {
    annualHrs: annualHrsR, semiHrs: semiHrsR, totalHrs,
    laborCost: totalHrs * laborCostPerHr,
    monthlyCharge: (totalHrs * lRate) / 12,
  };
}

function legacyPm(rows, extraHrs, techs, laborCostPerHr, lRate) {
  let deviceHrs = 0;
  rows.forEach((r) => {
    const count = parseFloat(r.count) || 0;
    const rateHrs = parseFloat(r.hrs) || 0;
    const rateMins = parseFloat(r.mins) || 0;
    const freq = parseFloat(r.freq) || 1;
    deviceHrs += count * (rateHrs + rateMins / 60) * freq;
  });
  const deviceHrsR = r4(deviceHrs);
  const extraHrsR = r4(parseFloat(extraHrs) || 0);
  const pmTechs = Math.max(1, parseFloat(techs) || 1);
  const totalHrs = (deviceHrsR + extraHrsR) * pmTechs;
  return {
    deviceHrs: deviceHrsR, extraHrs: extraHrsR, totalHrs,
    laborCost: totalHrs * laborCostPerHr,
    monthlyCharge: (totalHrs * lRate) / 12,
  };
}

const EPS = 0.005;
let checked = 0;
const mismatches = [];

const COUNTS = [0, 1, 7, 40];
const HRS = [0, 0.25, 2];
const MINS = [0, 15, 45];
const TECHS = [1, 2, 4];

for (const count of COUNTS) {
  for (const hrs of HRS) {
    for (const mins of MINS) {
      for (const techs of TECHS) {
        for (const extra of [0, 3, 10]) {
          const fireRows = [
            { count, hrs, mins, semi: true },
            { count: count * 2, hrs, mins, semi: false },
          ];
          checked++;
          const a = legacyFire(fireRows, extra, techs, LABOR_COST, BILL_RATE);
          const b = calcFireInspection(fireRows, extra, techs, LABOR_COST, BILL_RATE);
          for (const k of ['annualHrs', 'semiHrs', 'totalHrs', 'laborCost', 'monthlyCharge']) {
            if (Math.abs(a[k] - b[k]) > EPS) mismatches.push({ kind: 'fire', k, legacy: a[k], ported: b[k], count, hrs, mins, techs, extra });
          }

          const pmRows = [
            { count, hrs, mins, freq: 1 },
            { count, hrs, mins, freq: 4 },
          ];
          const c = legacyPm(pmRows, extra, techs, LABOR_COST, BILL_RATE);
          const d = calcPmInspection(pmRows, extra, techs, LABOR_COST, BILL_RATE);
          for (const k of ['deviceHrs', 'extraHrs', 'totalHrs', 'laborCost', 'monthlyCharge']) {
            if (Math.abs(c[k] - d[k]) > EPS) mismatches.push({ kind: 'pm', k, legacy: c[k], ported: d[k], count, hrs, mins, techs, extra });
          }
        }
      }
    }
  }
}

const cases = [];
const named = (n, c) => cases.push([n, c]);

// The rounding: hours bill in whole half-days, rounded UP, but zero stays zero.
named('roundTo4 leaves zero alone', roundTo4(0) === 0);
named('roundTo4 rounds a fraction up to 4', roundTo4(0.25) === 4);
named('roundTo4 leaves an exact multiple alone', roundTo4(8) === 8);
named('roundTo4 rounds 8.1 up to 12', roundTo4(8.1) === 12);

// The asymmetry.
{
  const rows = [{ count: 10, hrs: 1, mins: 0, semi: true }];
  const one = calcFireInspection(rows, 0, 1, LABOR_COST, BILL_RATE);
  const two = calcFireInspection(rows, 0, 2, LABOR_COST, BILL_RATE);
  // annual 10 -> 12, semi 10 -> 12. techs=1: 12+12=24. techs=2: 24+12=36.
  named('a second fire technician repeats the ANNUAL visit only',
    one.totalHrs === 24 && two.totalHrs === 36);
  named('a second fire technician does NOT double the whole inspection',
    two.totalHrs !== one.totalHrs * 2);
}
{
  const rows = [{ count: 10, hrs: 1, mins: 0, freq: 1 }];
  const one = calcPmInspection(rows, 4, 1, LABOR_COST, BILL_RATE);
  const two = calcPmInspection(rows, 4, 2, LABOR_COST, BILL_RATE);
  named('a second PM technician DOES multiply the whole visit',
    two.totalHrs === one.totalHrs * 2);
}
// Frequency multiplies device hours on a PM but has no fire equivalent.
{
  const once = calcPmInspection([{ count: 4, hrs: 1, mins: 0, freq: 1 }], 0, 1, LABOR_COST, BILL_RATE);
  const quarterly = calcPmInspection([{ count: 4, hrs: 1, mins: 0, freq: 4 }], 0, 1, LABOR_COST, BILL_RATE);
  named('PM frequency multiplies device hours', quarterly.deviceHrs === 16 && once.deviceHrs === 4);
}
// Minutes convert, and a zero row contributes nothing.
named('45 minutes is three quarters of an hour',
  calcFireInspection([{ count: 4, hrs: 0, mins: 45, semi: false }], 0, 1, LABOR_COST, BILL_RATE).annualHrs === 4);
named('an empty row contributes nothing',
  calcFireInspection([{ count: 0, hrs: 5, mins: 30, semi: true }], 0, 1, LABOR_COST, BILL_RATE).totalHrs === 0);
// Technicians floor at one, however the field is filled in.
named('zero technicians is treated as one',
  calcPmInspection([{ count: 4, hrs: 1, mins: 0, freq: 1 }], 0, 0, LABOR_COST, BILL_RATE).totalHrs === 4);

const bad = cases.filter(([, ok]) => !ok);

console.log(`\n  inspection: ${checked} input combinations checked (fire and PM)`);
for (const [n, ok] of cases) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}`);

if (mismatches.length === 0 && bad.length === 0) {
  console.log(`\n  No drift. Inspection labour matches legacy/index.html.\n`);
  process.exit(0);
}
if (mismatches.length) {
  console.log(`\n  ${mismatches.length} MISMATCH(ES):\n`);
  for (const m of mismatches.slice(0, 8)) {
    console.log(`    ${m.kind}.${m.k}: legacy ${m.legacy} vs ported ${m.ported}` +
      `  (count ${m.count}, ${m.hrs}h${m.mins}m, ${m.techs} techs, extra ${m.extra})`);
  }
}
console.log('');
process.exit(1);
