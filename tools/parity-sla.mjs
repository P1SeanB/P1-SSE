// SLA parity — does src/lib/sla.js agree with the legacy?
//
//   npm run parity:sla
//
// Transcribed independently from slaBudgetCalc (:9285-9307) and slaCalcSLARate
// (:9308-9350).
//
// The case this exists for is the PM visit rate. Every tier multiplier in this app
// applies to reactive service calls, so applying one to scheduled maintenance is the
// natural mistake — and it overcharges every Priority and Premier agreement while
// looking entirely reasonable.
import { slaAnnualBudget, slaRate, budgetLine, slaEndDate, parseMoney } from '../src/lib/sla.js';

const RATES = {
  misc: { pmVisitRate: 145 },
  serviceCall: {
    StraightTimeRate: 145, TimeAndHalfRate: 217.5, DoubleTimeRate: 290,
    PriorityMultiplier: 1.15, PremierMultiplier: 1.3,
  },
};

// ── Legacy transcription — :9286-9346 ───────────────────────────────────────
function legacyCalcRow(rate, hrs) {
  var r = parseFloat(rate) || 0;
  var h = parseFloat(hrs) || 0;
  return (r > 0 && h > 0) ? r * h : 0;
}

function legacySlaRate(i, P1_RATES) {
  var regTotal = legacyCalcRow(i.regularRate, i.regularHours);
  var ahTotal = legacyCalcRow(i.afterHoursRate, i.afterHoursHours);
  var emTotal = legacyCalcRow(i.emergencyRate, i.emergencyHours);

  // :9318 — PM billed at the STANDARD straight rate regardless of tier.
  var pmStraightRate = P1_RATES.misc.pmVisitRate;
  var visitCount = i.pmVisits || 1;
  var pmHrs = parseFloat(i.pmHours) || 0;
  var pmVal = pmHrs * visitCount * pmStraightRate;

  var matVal = parseFloat(String(i.materialsAmount ?? '').replace(/[^0-9.]/g, '')) || 0;
  var annualTotal = pmVal + regTotal + ahTotal + emTotal + matVal + (i.calloutTotal || 0);

  var monthlyBase = annualTotal / 12;
  var freq = i.frequency || 'monthly';
  var displayVal = freq === 'monthly' ? monthlyBase
    : freq === 'quarterly' ? monthlyBase * 3
    : monthlyBase * 12;
  return { annual: annualTotal, monthly: monthlyBase, display: displayVal };
}

// ── Grid ────────────────────────────────────────────────────────────────────
const EPS = 0.005;
let checked = 0;
const mismatches = [];

for (const regularRate of [0, 145, 217.5]) {
  for (const regularHours of [0, 8, 40]) {
    for (const afterHoursRate of [0, 217.5]) {
      for (const afterHoursHours of [0, 4]) {
        for (const emergencyRate of [0, 290]) {
          for (const emergencyHours of [0, 2]) {
            for (const pmHours of [0, 4, 7.5]) {
              for (const pmVisits of [1, 2, 4]) {
                for (const frequency of ['monthly', 'quarterly', 'annual']) {
                  const i = {
                    regularRate, regularHours, afterHoursRate, afterHoursHours,
                    emergencyRate, emergencyHours, pmHours, pmVisits, frequency,
                    materialsAmount: '$1,250.00', calloutTotal: 0,
                  };
                  checked++;
                  const a = legacySlaRate(i, RATES);
                  const b = slaRate(i, RATES);
                  for (const k of ['annual', 'monthly', 'display']) {
                    if (Math.abs(a[k] - b[k]) > EPS) {
                      mismatches.push({ i, field: k, legacy: a[k], ported: b[k] });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

const cases = [];
const named = (n, c) => cases.push([n, c]);

// The rule this harness exists for.
{
  const i = { pmHours: 8, pmVisits: 4, frequency: 'monthly' };
  const b = slaAnnualBudget(i, RATES);
  named('PM bills at the standard straight rate (no tier multiplier)',
    Math.abs(b.pm - 8 * 4 * 145) < EPS);
  named('PM is NOT marked up by the Premier multiplier',
    Math.abs(b.pm - 8 * 4 * 145 * 1.3) > 1);
}
// A rate with no hours is an unfinished line, not a zero-hour charge.
named('a rate with no hours contributes nothing', budgetLine(145, 0) === 0);
named('hours with no rate contribute nothing', budgetLine(0, 40) === 0);
named('both present multiply', Math.abs(budgetLine(145, 40) - 5800) < EPS);
// Currency-formatted input.
named('materials parse through a currency format', Math.abs(parseMoney('$1,250.00') - 1250) < EPS);
// Frequency is a presentation of one monthly figure.
{
  const i = { pmHours: 10, pmVisits: 1, materialsAmount: 0 };
  const m = slaRate({ ...i, frequency: 'monthly' }, RATES);
  const q = slaRate({ ...i, frequency: 'quarterly' }, RATES);
  const a = slaRate({ ...i, frequency: 'annual' }, RATES);
  named('quarterly is three monthlies', Math.abs(q.display - m.display * 3) < EPS);
  named('annual is twelve monthlies', Math.abs(a.display - m.display * 12) < EPS);
  named('the underlying monthly figure never changes with frequency',
    Math.abs(m.monthly - q.monthly) < EPS && Math.abs(m.monthly - a.monthly) < EPS);
}
// Term end date is the day BEFORE the anniversary.
named('a 12-month term from 2026-01-01 ends 2026-12-31', slaEndDate('2026-01-01', 12) === '2026-12-31');
named('a 36-month term from 2026-03-15 ends 2029-03-14', slaEndDate('2026-03-15', 36) === '2029-03-14');
named('a term crossing a leap day lands correctly', slaEndDate('2027-03-01', 12) === '2028-02-29');
named('an invalid start date yields nothing rather than a wrong date', slaEndDate('', 12) === '');
named('a zero-month term yields nothing', slaEndDate('2026-01-01', 0) === '');

const bad = cases.filter(([, ok]) => !ok);

console.log(`\n  slaRate: ${checked} input combinations checked`);
for (const [n, ok] of cases) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}`);

if (mismatches.length === 0 && bad.length === 0) {
  console.log(`\n  No drift. SLA rates match legacy/index.html.\n`);
  process.exit(0);
}
if (mismatches.length) {
  console.log(`\n  ${mismatches.length} MISMATCH(ES):\n`);
  for (const m of mismatches.slice(0, 8)) {
    console.log(`    ${m.field}: legacy ${m.legacy} vs ported ${m.ported}`);
  }
}
console.log('');
process.exit(1);
