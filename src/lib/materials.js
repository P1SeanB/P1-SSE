// Materials, installation labour, and the bill of materials.
//
// Ported from legacy/index.html — p1UnitDiv/p1MatCompute (:6355-6389),
// getMatData/getTotalMatSell/getTotalMatCost (:6390-6453), and the one-time totals
// block (:4525-4545).
//
// THE RULE THAT MATTERS MOST, transcribed from the legacy's own comment at :4531:
//
//   Billed is the sum of actual per-line sells. With package or manual costing the
//   JOB COST can differ from prorated usage, but the customer's price must not — so
//   billed is summed from line sells, never derived as cost x markup.
//
// A port that computes matBilled as matCost * (1 + markup) agrees with the legacy on
// every simple line and diverges the moment anyone uses package or manual costing —
// which is precisely when a job is large enough for the difference to matter.

/** Quantities can be entered per each, per 100 ft, or per 1,000 ft — :6355. */
export const unitDivisor = (unit) => (unit === '100ft' ? 100 : unit === '1000ft' ? 1000 : 1);

export const unitLabel = (unit) =>
  unit === '100ft' ? '100 ft' : unit === '1000ft' ? '1,000 ft' : unit || 'ea';

const num = (v, fallback = 0) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * One material line — :6362-6386.
 *
 * Three costing modes, and the distinction between them is the whole point:
 *
 *   actual   the job is charged for what it uses: cost x units
 *   package  whole packages must be bought, so the job carries the waste. Waste is
 *            applied BEFORE the rounding up (:6373), which is why 105 ft of a 100 ft
 *            reel with 10% waste is two reels, not one
 *   manual   somebody typed the real number, because reality disagreed with both
 *
 * The customer's SELL is unaffected by all of it. Only jobCost moves.
 */
export function computeMaterialLine(o = {}) {
  const uDiv = unitDivisor(o.unit || 'ea');
  const adjQty = num(o.qty) * (1 + num(o.waste) / 100);
  const units = adjQty / uDiv;

  const unitSellVal = num(o.cost) * (1 + num(o.matMarkup));
  const totalSell = unitSellVal * units;
  const usageCost = num(o.cost) * units;

  let jobCost = usageCost;
  let packages = 0;
  let err = '';
  let effMode = o.costBy || 'actual';

  if (effMode === 'package') {
    // Falls back to actual rather than refusing, so a half-configured row still
    // prices — but reports why, because a silent fallback is how someone ships a
    // quote that was meant to include package waste and does not.
    if (!(num(o.pkgSize) > 0)) {
      err = 'Package size is required for Full Package costing.';
      effMode = 'actual';
    } else if (!(num(o.cost) > 0)) {
      err = 'Package cost is required for Full Package costing.';
      effMode = 'actual';
    } else {
      // toFixed(9) before ceil — floating point makes 3 * (1/3) land at 1.0000000004,
      // and without it an exact fit silently buys one package too many.
      packages = Math.ceil(Number((adjQty / num(o.pkgSize)).toFixed(9)));
      jobCost = packages * (num(o.cost) * (num(o.pkgSize) / uDiv));
    }
  } else if (effMode === 'manual') {
    const mc = parseFloat(o.manualCost);
    if (Number.isNaN(mc)) {
      err = 'Manual Job Cost is required.';
      effMode = 'actual';
    } else {
      jobCost = mc;
    }
  }
  if (effMode === 'actual') jobCost = usageCost;

  // Installation labour attached to the line scales with units, not with the raw
  // quantity — 2 hours per 1,000 ft over 2,500 ft is 5 hours.
  const labHrs = num(o.lpHrs) * units;

  return { adjQty, units, unitSellVal, totalSell, usageCost, jobCost, packages, labHrs, err, effMode };
}

/**
 * Expand raw rows into priced items. A material row with attached labour hours emits
 * a SECOND item of type 'labor' — :6417-6423 — so every consumer (labour totals, the
 * labour card, the quote's labour section, the copy summary) picks it up with no
 * special-casing. It is flagged `attached` because export skips it: those hours
 * round-trip through the material row's own fields, and exporting both would
 * double-count them on re-import.
 */
export function priceRows(rows = [], opts = {}) {
  const matMarkup = num(opts.matMarkup, 0.69);
  const defaultLaborRate = num(opts.laborCostPerHr, 120);
  const defaultSellRate = num(opts.laborSellDefault, 180);
  const items = [];

  for (const row of rows) {
    const desc = String(row.desc ?? '').trim();

    if (row.type === 'material') {
      const cost = num(row.cost);
      // Only skip a row that is entirely empty; a described line with no cost yet is
      // still a line the estimator is working on.
      if (!desc && !(cost > 0)) continue;

      const qty = num(row.qty, 1);
      const laborRate = num(row.laborRate, defaultLaborRate);
      const laborSellRate = num(row.laborSellRate, defaultSellRate);
      const mc = computeMaterialLine({
        cost, qty, unit: row.unit || 'ea', matMarkup,
        lpHrs: num(row.laborHrs),
        waste: Math.min(100, Math.max(0, num(row.waste))),
        pkgSize: num(row.pkgSize),
        costBy: row.costBy || 'actual',
        manualCost: row.manualCost,
      });

      items.push({
        type: 'material', desc: desc || 'Material',
        cost, qty, unit: row.unit || 'ea',
        vendor: row.vendor ?? '', source: row.source ?? '',
        partNumber: row.partNumber ?? '', quoteNumber: row.quoteNumber ?? '',
        manufacturer: row.manufacturer ?? '', chargeTo: row.chargeTo ?? '',
        pkgSize: num(row.pkgSize), pkgUnit: row.pkgUnit ?? '',
        waste: num(row.waste), costBy: mc.effMode, manualCost: row.manualCost,
        adjQty: mc.adjQty, packages: mc.packages,
        lineTotal: mc.jobCost, unitSell: mc.unitSellVal, totalSell: mc.totalSell,
        err: mc.err,
      });

      if (num(row.laborHrs) > 0) {
        items.push({
          type: 'labor', attached: true,
          desc: `${desc || 'Material'} — Installation Labor`,
          hrs: Number(mc.labHrs.toFixed(2)),
          rate: laborRate, sellPerHr: laborSellRate,
          totalCost: mc.labHrs * laborRate,
          totalSell: mc.labHrs * laborSellRate,
        });
      }
    } else if (row.type === 'labor') {
      const hrs = num(row.hrs);
      if (!desc && !(hrs > 0)) continue;
      const rate = num(row.rate, defaultLaborRate);
      const sellPerHr = num(row.sellPerHr, defaultSellRate);
      items.push({
        type: 'labor', attached: false, desc: desc || 'Labor',
        hrs, rate, sellPerHr,
        chargeTo: row.chargeTo ?? '',
        totalCost: hrs * rate, totalSell: hrs * sellPerHr,
      });
    }
  }

  return items;
}

const sum = (items, pick) => items.reduce((s, i) => s + (pick(i) || 0), 0);

/** Customer-facing material total — summed from line sells. See the header. */
export const totalMaterialSell = (items) =>
  sum(items.filter((i) => i.type === 'material'), (i) => i.totalSell);

/** What the materials cost the job, honouring package and manual costing. */
export const totalMaterialCost = (items) =>
  sum(items.filter((i) => i.type === 'material'), (i) => i.lineTotal);

export const totalLaborCost = (items) =>
  sum(items.filter((i) => i.type === 'labor'), (i) => i.totalCost);

export const totalLaborSell = (items) =>
  sum(items.filter((i) => i.type === 'labor'), (i) => i.totalSell);

/**
 * The installation-labour margin — :4536-4539.
 *
 * Computed from actual cost against actual sell, because the sell rate is entered
 * per row and may not follow the default. Where nothing has been billed, the billed
 * amount falls back to cost, which yields a zero margin rather than a negative one.
 */
export function laborMargin(items) {
  const cost = totalLaborCost(items);
  const billed = totalLaborSell(items);
  const billedAmt = billed > 0 ? billed : cost;
  const gp = billedAmt - cost;
  return {
    cost, billed: billedAmt, gp,
    marginPct: billedAmt > 0 ? gp / billedAmt : null,
    gm: cost > 0 && billed > 0 ? (billed - cost) / billed : 0,
  };
}

export function materialMargin(items) {
  const cost = totalMaterialCost(items);
  const billed = totalMaterialSell(items);
  const gp = billed - cost;
  return { cost, billed, gp, marginPct: billed > 0 ? gp / billed : null };
}

/**
 * Bill of materials, grouped by vendor — the BOM export added in Aug 2026.
 *
 * Attached labour is excluded: it is not a thing anyone buys, and it would appear on
 * a purchase order as a line the vendor cannot fulfil.
 */
export function billOfMaterials(items) {
  const byVendor = new Map();
  for (const i of items) {
    if (i.type !== 'material') continue;
    const vendor = (i.vendor || '').trim() || 'Unassigned';
    if (!byVendor.has(vendor)) byVendor.set(vendor, []);
    byVendor.get(vendor).push(i);
  }
  return [...byVendor.entries()]
    .sort(([a], [b]) => (a === 'Unassigned' ? 1 : b === 'Unassigned' ? -1 : a.localeCompare(b)))
    .map(([vendor, lines]) => ({
      vendor,
      lines,
      cost: sum(lines, (l) => l.lineTotal),
      sell: sum(lines, (l) => l.totalSell),
    }));
}

/**
 * Which columns a BOM export should include — :"BOM export: omit columns no line
 * filled in". An export carrying eight empty columns is one nobody reads.
 */
export function bomColumns(items) {
  const optional = ['vendor', 'source', 'partNumber', 'quoteNumber', 'manufacturer', 'chargeTo', 'pkgUnit'];
  const materials = items.filter((i) => i.type === 'material');
  return optional.filter((key) => materials.some((i) => String(i[key] ?? '').trim() !== ''));
}
