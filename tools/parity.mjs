// Pricing parity harness — does the port still agree with the app estimators use?
//
//   npm run parity
//
// THE RISK THIS EXISTS FOR is not infrastructure, it is silent formula drift. The
// port was made from legacy/index.html in July and was faithful then. `main` has
// since added 4,000 lines to that file, and a pricing line can change inside it
// without anything here failing to build, failing a test, or looking wrong. An
// estimator would simply quote a different number from the person at the next desk.
//
// It has already happened once. The RMR rounding changed from "next $5" to "next
// dollar" in Aug 2026, in both of the legacy file's copies of the formula, and this
// harness is what found it.
//
// HOW IT WORKS. Both engines are JavaScript. The legacy formulas are re-implemented
// here ONCE, transcribed directly from legacy/index.html with line citations, and
// run against src/lib/calc.js over a grid of representative inputs. Any cell where
// the two disagree by more than a rounding epsilon is reported.
//
// Re-transcribing rather than executing the legacy file is deliberate: the original
// is a DOM-coupled 16k-line script that reads its inputs from document.getElementById
// and writes results into elements. Standing up enough of a DOM to run it would test
// the harness more than the arithmetic. The cost is that these transcriptions must be
// re-checked when the legacy changes — which is the job, and why every one cites the
// line it came from.
import { computeQuote, calcRMR } from '../src/lib/calc.js';

// ── Legacy transcriptions ───────────────────────────────────────────────────
// Each is a direct reading of legacy/index.html at the cited lines. Update the
// citation when you update the formula, or the next person cannot check your work.

// :4508 — function calcRMR(totalCosts, gmTarget)
function legacyCalcRMR(totalCosts, gmTarget) {
  return totalCosts > 0 ? totalCosts / (12 * (1 - gmTarget)) : 0;
}

// :4593-4605 — the profit block. These are the figures that tell an estimator
// whether a job makes money, and until now only recommendedRMR was checked: a quote
// could price correctly and report the wrong margin, which is the number someone
// decides to take the work on.
//
// The overhead METHOD is the part worth pinning. Overhead applies to costs or to
// revenue depending on the setting, and on a high-margin job those differ
// substantially — 12% of $40,000 revenue against 12% of $22,000 cost. Defaulting the
// wrong way flatters or punishes every quote.
function legacyProfit(i, rates, recommendedRMR) {
  const isTM = ['Time & Material Only', 'Material Only', 'Budget Estimate', 'Flat Rate Estimate']
    .includes(i.systemType);
  const inspCost = i.inspHours * rates.labor.LaborCostPerHr;
  const inspBilled = i.inspHours * i.laborRate;
  const subMonthly = i.annualSub / 12;
  const mDirect = i.monthlyCosts + inspCost / 12 + subMonthly + i.avMaint / 12;
  const totalCosts = mDirect * 12;

  const rmrIsManual = i.quotedMonthly > 0 && !isTM;
  const rmrEff = rmrIsManual ? i.quotedMonthly : recommendedRMR;

  const annRev = rmrEff * 12;
  const annGP = annRev - totalCosts;
  const annOH = i.ohMethod === 'cost' ? totalCosts * i.overheadRate : annRev * i.overheadRate;
  const annNP = annGP - annOH;
  const gm = annRev > 0 ? annGP / annRev : null;
  const nm = annRev > 0 ? annNP / annRev : null;

  const laborGP = inspBilled - inspCost;
  const laborMargin = inspBilled > 0 ? laborGP / inspBilled : null;

  return { totalCosts, annRev, annGP, annOH, annNP, gm, nm, laborGP, laborMargin };
}

// :4575-4581 — the recommended-RMR block of the main quote calculation.
function legacyRecommendedRMR(i, rates) {
  const inspCost = i.inspHours * rates.labor.LaborCostPerHr;
  const inspBilled = i.inspHours * i.laborRate;
  const inspBilledMonthly = inspBilled / 12;

  const monOnlyCosts = i.monthlyCosts * 12;
  const subBilled = i.annualSub * (1 + i.subMarkup);
  const isTM = [
    'Time & Material Only', 'Material Only', 'Budget Estimate', 'Flat Rate Estimate',
  ].includes(i.systemType);
  const subRMR = isTM ? 0 : subBilled / 12;

  const avMaintBilled = i.avMaint > 0 ? i.avMaint / (1 - i.avMaintGM) : 0;
  const avMaintRMR = avMaintBilled / 12;

  // :4576-4577 — the preserved bug. systemType never equals 'Fire' or 'Burglar'
  // (the real values are 'Fire Monitoring & Services' etc.), so this floor never
  // applies. Transcribed as-is: the harness's job is to prove the port MATCHES the
  // legacy, including where the legacy is wrong.
  const isCommercial = i.siteType === 'Commercial';
  const isFireOrBurglar = ['Fire', 'Burglar'].includes(i.systemType);
  const minRMR = isFireOrBurglar
    ? (isCommercial ? rates.minRmr.CommercialFloor : rates.minRmr.ResidentialFloor)
    : (i.systemType === 'Two-Way Monitoring & Services' ? rates.minRmr.TwoWayFloor : 0);

  const monRMR53 = Math.max(minRMR, legacyCalcRMR(monOnlyCosts, i.svcGM));
  const laborRMR = inspBilledMonthly;
  const rmr53Raw = Math.max(minRMR, monRMR53 + subRMR + laborRMR + avMaintRMR);

  // :4581 — whole dollars. Was Math.ceil(rmr53Raw / 5) * 5 until Aug 2026.
  void inspCost;
  return rmr53Raw > 0 ? Math.ceil(rmr53Raw) : rmr53Raw;
}

// ── The grid ────────────────────────────────────────────────────────────────
// Chosen to cross the branches that actually decide a price: the T&M split, the
// commercial/residential floor, zero vs non-zero subcontractor and A/V maintenance,
// and margins either side of the defaults.
const RATES = {
  labor: { LaborCostPerHr: 48 },
  minRmr: { CommercialFloor: 75, ResidentialFloor: 45, TwoWayFloor: 30 },
};

const SYSTEM_TYPES = [
  'Fire Monitoring & Services',
  'Burglar Monitoring & Services',
  'Two-Way Monitoring & Services',
  'Access Hosting & PM Services',
  'Time & Material Only',       // the T&M branch: subRMR must drop to zero
  'Flat Rate Estimate',
];

function* grid() {
  for (const systemType of SYSTEM_TYPES) {
    for (const siteType of ['Commercial', 'Residential']) {
      for (const monthlyCosts of [0, 12.5, 137.75]) {
        for (const inspHours of [0, 3.5, 24]) {
          for (const annualSub of [0, 1200]) {
            for (const avMaint of [0, 900]) {
              for (const svcGM of [0.35, 0.45, 0.6]) {
                yield {
                  systemType, siteType, monthlyCosts, inspHours, annualSub, avMaint,
                  svcGM,
                  laborRate: 145,
                  subMarkup: 0.15,
                  avMaintGM: 0.4,
                  quotedMonthly: 0,
                };
              }
            }
          }
        }
      }
    }
  }
}

// Money compared at the cent. A difference smaller than this is float noise; a
// difference larger is a real quote discrepancy.
const EPSILON = 0.005;

let checked = 0;
const mismatches = [];

// Every quote is now checked twice over: once on the price, and once on all six
// profit figures derived from it, under BOTH overhead methods.
const PROFIT_FIELDS = ['totalCosts', 'annRev', 'annGP', 'annOH', 'annNP', 'gm', 'nm', 'laborGP', 'laborMargin'];

for (const base of grid()) {
  for (const ohMethod of ['revenue', 'cost']) {
    for (const overheadRate of [0, 0.12]) {
      const input = { ...base, ohMethod, overheadRate };
      checked++;

      const legacyRmr = legacyRecommendedRMR(input, RATES);
      const portedAll = computeQuote(input, RATES);
      if (Math.abs(legacyRmr - portedAll.recommendedRMR) > EPSILON) {
        mismatches.push({
          input, legacy: legacyRmr, ported: portedAll.recommendedRMR,
          delta: portedAll.recommendedRMR - legacyRmr, field: 'recommendedRMR',
        });
      }

      const legacyP = legacyProfit(input, RATES, legacyRmr);
      for (const f of PROFIT_FIELDS) {
        const a = legacyP[f];
        const b = portedAll[f];
        // null is a real value here — a margin is undefined with no revenue, and
        // reporting 0% instead would read as a break-even job rather than an empty
        // one.
        if (a === null || b === null) {
          if (a !== b) mismatches.push({ input, legacy: a, ported: b, delta: 0, field: f });
          continue;
        }
        if (Math.abs(a - b) > EPSILON) {
          mismatches.push({ input, legacy: a, ported: b, delta: b - a, field: f });
        }
      }
    }
  }
}

// calcRMR is used directly by other screens, so check it on its own too.
let calcRmrMismatches = 0;
for (const total of [0, 100, 1234.56, 99999]) {
  for (const gm of [0, 0.35, 0.45, 0.6]) {
    if (Math.abs(legacyCalcRMR(total, gm) - calcRMR(total, gm)) > EPSILON) calcRmrMismatches++;
  }
}

console.log(`\n  calcRMR:      ${calcRmrMismatches === 0 ? 'matches' : calcRmrMismatches + ' MISMATCHES'}`);
console.log(`  computeQuote: ${checked} input combinations checked`);

if (mismatches.length === 0) {
  console.log(`\n  No drift. The port prices identically to legacy/index.html.\n`);
  process.exit(calcRmrMismatches === 0 ? 0 : 1);
}

console.log(`\n  ${mismatches.length} MISMATCH(ES) — the new tool would quote a different price:\n`);
for (const m of mismatches.slice(0, 12)) {
  const i = m.input;
  console.log(
    `    legacy $${m.legacy.toFixed(2)}  vs  ported $${m.ported.toFixed(2)}` +
      `  (${m.delta > 0 ? '+' : ''}${m.delta.toFixed(2)}/mo)`,
  );
  console.log(
    `      ${i.systemType} · ${i.siteType} · monthly ${i.monthlyCosts} · insp ${i.inspHours}h` +
      ` · sub ${i.annualSub} · avMaint ${i.avMaint} · svcGM ${i.svcGM}`,
  );
}
if (mismatches.length > 12) console.log(`    … and ${mismatches.length - 12} more`);
console.log(
  `\n  Do not ship this. Either the port is stale, or the legacy changed — check\n` +
    `  legacy/index.html against the citations in src/lib/calc.js and in this file.\n`,
);
process.exit(1);
