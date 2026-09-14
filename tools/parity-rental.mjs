// Rental equipment parity — does src/lib/rental.js price identically to the legacy?
//
//   npm run parity:rental
//
// Rental landed in the legacy on 14 Sep 2026 (main af1427c) and is the newest thing
// in this port, so it is the most likely to be wrong and the least likely to be
// noticed: it appears only on jobs that hire a lift, and a wrong number there still
// looks like a plausible number.
//
// The legacy side below is transcribed independently from syncRentalRows
// (legacy/index.html:5899-5924) and the calc() roll-up (:4700, :4902-4904), keeping
// the legacy's own shape — var, the same order of operations, the same defaults — so
// the two implementations can genuinely disagree rather than being the same code
// written twice.
import {
  computeRentalTotals, printableRentalLines, hasRental,
  RENTAL_UNITS, RENTAL_MARKUP_DEFAULT,
} from '../src/lib/rental.js';
import {
  priceRows, computeTmSubTotals, computeOneTimeTotal, computeOneTimeMargin,
} from '../src/lib/materials.js';

// ── Legacy transcription — :5899-5924 ───────────────────────────────────────
// syncRentalRows reads the DOM; the arithmetic it performs is this.
function legacySyncRentalRows(rows, markupPct, deliveryVal) {
  var markup = (isFinite(parseFloat(markupPct)) ? parseFloat(markupPct) : 15) / 100;  // :5892-5897
  var equipCost = 0;
  var lineBilled = [];
  rows.forEach(function (r) {
    var qty = parseFloat(r.qty) || 0;
    var cost = parseFloat(r.cost) || 0;
    var ext = qty * cost;                 // :5908
    equipCost += ext;
    lineBilled.push(ext * (1 + markup));  // :5911
  });
  var delivery = parseFloat(deliveryVal) || 0;   // :5914
  var totalCost = equipCost + delivery;          // :5915
  var totalBilled = totalCost * (1 + markup);    // :5916
  return { equipCost, delivery, totalCost, totalBilled, lineBilled, markup };
}

// getRentalRows — :5926-5942. Note the filter: a row is kept if it has a description
// OR a cost, so a half-typed row prices at zero but does not print.
function legacyGetRentalRows(rows) {
  var items = [];
  rows.forEach(function (r) {
    var desc = r.desc || '';
    var cost = parseFloat(r.cost) || 0;
    if (desc || cost > 0) items.push({ desc: desc, qty: parseFloat(r.qty) || 0, unit: r.unit || 'Day', cost: cost });
  });
  return items;
}

// The one-time roll-up — :4700 and :4902-4904.
function legacyOneTime(laborBilled, matBilled, tmSubBilled, rentalBilled, matTaxAmt, shBilled) {
  return laborBilled + matBilled + tmSubBilled + rentalBilled + matTaxAmt + shBilled;  // :4700
}
function legacyCombined(laborCost, matCost, tmSubRate, rentalCost) {
  return laborCost + matCost + tmSubRate + rentalCost;  // :4902
}

// ── Grid ────────────────────────────────────────────────────────────────────
const EPS = 0.005;
let checked = 0;
const mismatches = [];

const QTYS = [0, 1, 3, 7, 30];
const COSTS = [0, 42.5, 375, 1250.75];
const MARKUPS = [0, 15, 22, 50];
const DELIVERIES = [0, 85, 250.5];

for (const qty of QTYS) {
  for (const cost of COSTS) {
    for (const markupPct of MARKUPS) {
      for (const delivery of DELIVERIES) {
        for (const unit of RENTAL_UNITS) {
          // Two rows, so an implementation that returns the first line rather than
          // the sum is visible.
          const rows = [
            { desc: 'Scissor lift', qty, unit, cost },
            { desc: 'Boom lift', qty: 1, unit, cost: 500 },
          ];
          checked++;
          const a = legacySyncRentalRows(rows, markupPct, delivery);
          const b = computeRentalTotals(rows, { rentalMarkup: markupPct / 100, delivery });

          if (Math.abs(a.equipCost - b.equipmentCost) > EPS) {
            mismatches.push({ rows, field: 'equipmentCost', legacy: a.equipCost, ported: b.equipmentCost, markupPct, delivery });
          }
          if (Math.abs(a.totalCost - b.cost) > EPS) {
            mismatches.push({ rows, field: 'cost', legacy: a.totalCost, ported: b.cost, markupPct, delivery });
          }
          if (Math.abs(a.totalBilled - b.billed) > EPS) {
            mismatches.push({ rows, field: 'billed', legacy: a.totalBilled, ported: b.billed, markupPct, delivery });
          }
          for (let i = 0; i < a.lineBilled.length; i++) {
            if (Math.abs(a.lineBilled[i] - b.lines[i].billed) > EPS) {
              mismatches.push({ rows, field: `lines[${i}].billed`, legacy: a.lineBilled[i], ported: b.lines[i].billed, markupPct, delivery });
            }
          }
        }
      }
    }
  }
}

// ── Named cases ─────────────────────────────────────────────────────────────
const cases = [];
const named = (name, cond) => cases.push([name, cond]);

// THE TRAP. src/lib/materials.js is one file away and its `unit` is a DIVISOR —
// '100ft' divides the quantity by 100. Rental units are labels. A port that reached
// for unitDivisor would price a 7-day lift hire at 1/100th and the estimate would
// still add up.
{
  const priced = RENTAL_UNITS.map((unit) =>
    computeRentalTotals([{ desc: 'Lift', qty: 7, unit, cost: 100 }], { rentalMarkup: 0.15 }).billed);
  named('the rental unit is a label, never a divisor — all four units price the same',
    priced.every((p) => Math.abs(p - 700 * 1.15) < EPS));
}

// The customer sees the line bills AND the total. They have to agree.
{
  const t = computeRentalTotals(
    [{ desc: 'A', qty: 3, cost: 133.33 }, { desc: 'B', qty: 2, cost: 66.67 }],
    { rentalMarkup: 0.15, delivery: 85 });
  const fromLines = t.lines.reduce((s, l) => s + l.billed, 0) + t.deliveryBilled;
  named('the total equals the sum of its own printed lines, to the cent',
    Math.abs(t.billed - fromLines) < 0.005);
}

// Markup, not gross margin — the mistake already made once in this codebase, on the
// T&M subcontract slider.
{
  const t = computeRentalTotals([{ desc: 'Lift', qty: 1, cost: 1000 }], { rentalMarkup: 0.15 });
  named('markup is applied as cost x (1 + rate)', Math.abs(t.billed - 1150) < EPS);
  named('markup is NOT applied as a true gross margin', Math.abs(t.billed - 1000 / 0.85) > 1);
}

// The pickup / drop-off charge is a vendor charge and is marked up like the rest.
{
  const t = computeRentalTotals([], { rentalMarkup: 0.15, delivery: 200 });
  named('the pickup / drop-off charge is marked up, not passed through at cost',
    Math.abs(t.billed - 230) < EPS && Math.abs(t.cost - 200) < EPS);
}

// The default, for a caller that supplies no markup at all.
{
  const t = computeRentalTotals([{ qty: 1, cost: 100 }]);
  named('the default markup is 15%',
    Math.abs(t.billed - 115) < EPS && RENTAL_MARKUP_DEFAULT === 0.15);
}

// getRentalRows filters; syncRentalRows does not. Money must not depend on which.
{
  const rows = [
    { desc: 'Lift', qty: 2, cost: 150 },
    { desc: '', qty: 1, cost: 0 },                // half-typed: priced at zero, not printed
    { desc: 'Delivery truck', qty: 1, cost: 0 },  // described, no price yet: printed
  ];
  const t = computeRentalTotals(rows, { rentalMarkup: 0.15 });
  const printable = printableRentalLines(t);
  const legacyRows = legacyGetRentalRows(rows);
  named('printable lines match the legacy getRentalRows filter',
    printable.length === legacyRows.length && printable.length === 2);
  named('an unprinted row costs nothing, so filtering cannot move the total',
    Math.abs(t.billed - 300 * 1.15) < EPS);
}

// hasRental gates the panel — :4742.
named('hasRental is false for an empty sheet and true once anything is entered',
  !hasRental(computeRentalTotals([], {}))
  && hasRental(computeRentalTotals([{ qty: 1, cost: 1 }], {})));

// ── Rental inside the one-time roll-up ──────────────────────────────────────
{
  const items = priceRows([
    { type: 'material', desc: 'Panel', cost: 100, qty: 10 },
    { type: 'labor', desc: 'Install', hrs: 10, rate: 100, sellPerHr: 150 },
  ], { matMarkup: 0 });
  const tmSub = computeTmSubTotals([{ cost: 1000 }], { tmSubGM: 0.42 });
  const rental = computeRentalTotals([{ desc: 'Lift', qty: 5, cost: 200 }], { rentalMarkup: 0.15, delivery: 100 });

  const t = computeOneTimeTotal(items, tmSub, {
    matTaxRate: 0.0825, shippingCost: 200, shippingMarkup: 0.15, rental,
  });

  // rental: (1000 + 100) x 1.15 = 1265
  named('the one-time total carries the rental billed amount',
    Math.abs(t.rentalBilled - 1265) < EPS);
  named('one-time total = labour + materials + sub + rental + tax + shipping',
    Math.abs(t.total - legacyOneTime(1500, 1000, 1420, 1265, 1000 * 0.0825, 230)) < EPS);

  // THE ONE THAT COSTS MONEY IF WRONG. Tax is on materials only. If rental were
  // folded into the tax base, every taxable job with a lift would be overcharged.
  named('rental is UNTAXED — the tax base is materials alone',
    Math.abs(t.materialTax - 1000 * 0.0825) < EPS);

  const m = computeOneTimeMargin(items, tmSub, { rental, overheadRate: 0.28, ohMethod: 'revenue' });
  named('the combined one-time COST carries the rental cost',
    Math.abs(m.cost - legacyCombined(1000, 1000, 1000, 1100)) < EPS);
  named('the combined one-time BILLED carries the rental billed',
    Math.abs(m.billed - (1500 + 1000 + 1420 + 1265)) < EPS);
  named('overhead applies to billed under the revenue method',
    Math.abs(m.overhead - (1500 + 1000 + 1420 + 1265) * 0.28) < EPS);
  named('overhead applies to cost under the cost method',
    Math.abs(computeOneTimeMargin(items, tmSub, { rental, overheadRate: 0.28, ohMethod: 'cost' }).overhead
      - 4100 * 0.28) < EPS);
  named('net profit is gross profit less overhead',
    Math.abs(m.netProfit - (m.gp - m.overhead)) < EPS);
}

// A quote with NOTHING but a rental still counts as carrying one-time work — the
// reason the legacy widened this gate (:4890-4895). Before the change, an RMR quote
// whose only one-time cost was a lift showed no one-time panel and printed no line.
{
  const rental = computeRentalTotals([{ desc: 'Lift', qty: 1, cost: 900 }], { rentalMarkup: 0.15 });
  const m = computeOneTimeMargin([], null, { rental });
  named('a rental-only quote still reports one-time work',
    m.hasOneTime === true && Math.abs(m.cost - 900) < EPS);
}

// A caller that has not been updated omits rental rather than corrupting the total.
{
  const items = priceRows([{ type: 'material', desc: 'Panel', cost: 100, qty: 10 }], { matMarkup: 0 });
  const t = computeOneTimeTotal(items, null, { matTaxRate: 0.0825, shippingCost: 200, shippingMarkup: 0.15 });
  named('omitting rental leaves tax and shipping intact',
    t.rentalBilled === 0 && Math.abs(t.materialTax - 82.5) < EPS && Math.abs(t.shippingBilled - 230) < EPS);
}

const badCases = cases.filter(([, ok]) => !ok);

console.log(`\n  computeRentalTotals: ${checked} input combinations checked`);
for (const [name, okc] of cases) console.log(`  ${okc ? 'ok  ' : 'FAIL'} ${name}`);

if (mismatches.length === 0 && badCases.length === 0) {
  console.log(`\n  No drift. Rental equipment prices identically to legacy/index.html.\n`);
  process.exit(0);
}

if (mismatches.length) {
  console.log(`\n  ${mismatches.length} MISMATCH(ES):\n`);
  for (const m of mismatches.slice(0, 8)) {
    console.log(`    ${m.field}: legacy ${m.legacy} vs ported ${m.ported}`);
    console.log(`      markup ${m.markupPct}%  delivery ${m.delivery}  rows ${JSON.stringify(m.rows)}`);
  }
  if (mismatches.length > 8) console.log(`    … and ${mismatches.length - 8} more`);
}
console.log('');
process.exit(1);
