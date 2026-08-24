// Materials parity — does src/lib/materials.js price identically to the legacy?
//
//   npm run parity:materials
//
// Transcribed independently from legacy/index.html p1MatCompute (:6362-6386) and the
// totals at :4525-4545, so the two implementations can genuinely disagree.
//
// The case this exists for is package and manual costing. A port that derives the
// customer's price as cost x markup agrees with the legacy on every simple line and
// diverges the moment anyone buys whole reels — which is exactly when the job is big
// enough for the difference to be money.
import {
  computeMaterialLine, priceRows, totalMaterialSell, totalMaterialCost,
  laborMargin, billOfMaterials, bomColumns, unitDivisor,
} from '../src/lib/materials.js';

// ── Legacy transcription — :6355, :6362-6386 ────────────────────────────────
function legacyUnitDiv(u) { return u === '100ft' ? 100 : u === '1000ft' ? 1000 : 1; }

function legacyMatCompute(o) {
  var uDiv = legacyUnitDiv(o.unit || 'ea');
  var adjQty = (o.qty || 0) * (1 + (o.waste || 0) / 100);
  var units = adjQty / uDiv;
  var unitSellVal = (o.cost || 0) * (1 + (o.matMarkup || 0));
  var totalSell = unitSellVal * units;
  var usageCost = (o.cost || 0) * units;
  var jobCost = usageCost, packages = 0, err = '', effMode = o.costBy || 'actual';
  if (effMode === 'package') {
    if (!(o.pkgSize > 0)) { err = 'Package size is required for Full Package costing.'; effMode = 'actual'; }
    else if (!(o.cost > 0)) { err = 'Package cost is required for Full Package costing.'; effMode = 'actual'; }
    else {
      packages = Math.ceil(+((adjQty / o.pkgSize).toFixed(9)));
      jobCost = packages * (o.cost * (o.pkgSize / uDiv));
    }
  } else if (effMode === 'manual') {
    var mc = parseFloat(o.manualCost);
    if (isNaN(mc)) { err = 'Manual Job Cost is required.'; effMode = 'actual'; }
    else jobCost = mc;
  }
  if (effMode === 'actual') jobCost = usageCost;
  var labHrs = (o.lpHrs || 0) * units;
  return { adjQty, units, unitSellVal, totalSell, usageCost, jobCost, packages, labHrs, err, effMode };
}

// ── Grid ────────────────────────────────────────────────────────────────────
const EPS = 0.005;
let checked = 0;
const mismatches = [];

const COSTS = [0, 0.42, 18.75, 1250];
const QTYS = [0, 1, 105, 2500, 3];
const UNITS = ['ea', '100ft', '1000ft'];
const WASTES = [0, 10, 100];
const MODES = ['actual', 'package', 'manual'];
const PKG_SIZES = [0, 100, 1000];
const MARKUPS = [0, 0.69, 2.0];

for (const cost of COSTS) {
  for (const qty of QTYS) {
    for (const unit of UNITS) {
      for (const waste of WASTES) {
        for (const costBy of MODES) {
          for (const pkgSize of PKG_SIZES) {
            for (const matMarkup of MARKUPS) {
              const o = {
                cost, qty, unit, waste, costBy, pkgSize, matMarkup,
                lpHrs: 2, manualCost: costBy === 'manual' ? '875.50' : '',
              };
              checked++;
              const a = legacyMatCompute(o);
              const b = computeMaterialLine(o);
              for (const k of ['adjQty', 'units', 'unitSellVal', 'totalSell', 'usageCost', 'jobCost', 'packages', 'labHrs']) {
                if (Math.abs((a[k] || 0) - (b[k] || 0)) > EPS) {
                  mismatches.push({ o, field: k, legacy: a[k], ported: b[k] });
                }
              }
              if (a.effMode !== b.effMode) {
                mismatches.push({ o, field: 'effMode', legacy: a.effMode, ported: b.effMode });
              }
            }
          }
        }
      }
    }
  }
}

// Named cases where a naive port is wrong in a way the grid could average over.
const cases = [];
const named = (name, cond) => cases.push([name, cond]);

// Waste before rounding: 105 ft of a 100 ft reel at 10% waste is 115.5 ft = 2 reels.
{
  const r = computeMaterialLine({ cost: 50, qty: 105, unit: 'ea', waste: 10, costBy: 'package', pkgSize: 100, matMarkup: 0 });
  named('waste applies before package rounding (2 packages, not 1)', r.packages === 2);
}
// An exact fit must not buy a spare through floating point.
{
  const r = computeMaterialLine({ cost: 10, qty: 3000, unit: 'ea', waste: 0, costBy: 'package', pkgSize: 1000, matMarkup: 0 });
  named('an exact fit buys exactly 3 packages', r.packages === 3);
}
// The customer's price does not move when the job's costing does.
{
  const base = { cost: 2, qty: 500, unit: '100ft', waste: 0, matMarkup: 0.69, lpHrs: 0 };
  const actual = computeMaterialLine({ ...base, costBy: 'actual' });
  const pkg = computeMaterialLine({ ...base, costBy: 'package', pkgSize: 100 });
  const manual = computeMaterialLine({ ...base, costBy: 'manual', manualCost: '9999' });
  named('sell is identical across all three costing modes',
    Math.abs(actual.totalSell - pkg.totalSell) < EPS && Math.abs(actual.totalSell - manual.totalSell) < EPS);
  named('job cost DOES differ by costing mode', Math.abs(actual.jobCost - manual.jobCost) > EPS);
}
// A half-configured package row falls back rather than pricing at zero.
{
  const r = computeMaterialLine({ cost: 5, qty: 10, costBy: 'package', pkgSize: 0, matMarkup: 0 });
  named('package costing without a size falls back to actual and says why',
    r.effMode === 'actual' && r.err !== '');
}
// Attached labour scales with units, not raw quantity.
{
  const items = priceRows([{ type: 'material', desc: 'Cable', cost: 1, qty: 2500, unit: '1000ft', laborHrs: 2 }], { matMarkup: 0 });
  const lab = items.find((i) => i.type === 'labor');
  named('attached labour scales with units (2 hrs/1000ft over 2500ft = 5 hrs)', lab && Math.abs(lab.hrs - 5) < 0.005);
  named('attached labour is flagged so export skips it', lab && lab.attached === true);
}
// Billed is summed from line sells, not derived from total cost.
{
  const items = priceRows([
    { type: 'material', desc: 'A', cost: 10, qty: 1, costBy: 'manual', manualCost: '500' },
    { type: 'material', desc: 'B', cost: 20, qty: 2 },
  ], { matMarkup: 0.5 });
  const sell = totalMaterialSell(items);
  const cost = totalMaterialCost(items);
  named('billed is summed from line sells, not cost x markup',
    Math.abs(sell - (15 + 60)) < EPS && Math.abs(cost - (500 + 40)) < EPS);
}
// BOM grouping and column pruning.
{
  const items = priceRows([
    { type: 'material', desc: 'A', cost: 1, qty: 1, vendor: 'Graybar', partNumber: 'X1' },
    { type: 'material', desc: 'B', cost: 2, qty: 1, vendor: 'Anixter' },
    { type: 'material', desc: 'C', cost: 3, qty: 1 },
  ], {});
  const bom = billOfMaterials(items);
  named('BOM groups by vendor with Unassigned last',
    bom.length === 3 && bom[bom.length - 1].vendor === 'Unassigned');
  const cols = bomColumns(items);
  named('BOM omits columns no line filled in',
    cols.includes('vendor') && cols.includes('partNumber') && !cols.includes('quoteNumber'));
}
named('unitDivisor matches the legacy table',
  unitDivisor('ea') === 1 && unitDivisor('100ft') === 100 && unitDivisor('1000ft') === 1000);
{
  const items = priceRows([{ type: 'labor', desc: 'Trim', hrs: 10, rate: 100, sellPerHr: 150 }], {});
  const m = laborMargin(items);
  named('labour margin uses actual cost against actual sell', Math.abs(m.marginPct - (500 / 1500)) < 0.001);
}

const badCases = cases.filter(([, ok]) => !ok);

console.log(`\n  computeMaterialLine: ${checked} input combinations checked`);
for (const [name, okc] of cases) console.log(`  ${okc ? 'ok  ' : 'FAIL'} ${name}`);

if (mismatches.length === 0 && badCases.length === 0) {
  console.log(`\n  No drift. Materials price identically to legacy/index.html.\n`);
  process.exit(0);
}

if (mismatches.length) {
  console.log(`\n  ${mismatches.length} MISMATCH(ES):\n`);
  for (const m of mismatches.slice(0, 8)) {
    console.log(`    ${m.field}: legacy ${m.legacy} vs ported ${m.ported}`);
    console.log(`      cost ${m.o.cost} qty ${m.o.qty} ${m.o.unit} waste ${m.o.waste}% ${m.o.costBy} pkg ${m.o.pkgSize}`);
  }
  if (mismatches.length > 8) console.log(`    … and ${mismatches.length - 8} more`);
}
console.log('');
process.exit(1);
