// Pure pricing math ported from legacy/index.html.
// Every formula cites the legacy line it was ported from so the numbers can be
// diffed against the old tool during cutover.

export const TM_TYPES = ['Time & Material Only', 'Material Only', 'Budget Estimate', 'Flat Rate Estimate'];

// legacy/index.html:4233 — RMR = totalCosts / (12 * (1 - gmTarget))
export function calcRMR(totalCosts, gmTarget) {
  if (totalCosts <= 0) return 0;
  return totalCosts / (12 * (1 - gmTarget));
}

// legacy/index.html:7039,7103 — hours round UP to the next multiple of 4
export function roundTo4(v) {
  return v === 0 ? 0 : Math.ceil(v / 4) * 4;
}

// Fire inspection calculator — legacy/index.html:7090-7111
// rows: [{ key, semi, hrs, mins, count }]
export function calcFireInspection(rows, pmHrs, technicians, laborCostPerHr, billRate) {
  let annualHrs = 0;
  let semiHrs = 0;
  for (const r of rows) {
    const h = (Number(r.count) || 0) * ((Number(r.hrs) || 0) + (Number(r.mins) || 0) / 60);
    annualHrs += h;
    if (r.semi) semiHrs += h;
  }
  const annualR = roundTo4(annualHrs);
  const semiR = roundTo4(semiHrs);
  const pmR = roundTo4(Number(pmHrs) || 0);
  const techs = Math.max(1, Number(technicians) || 1);
  // legacy:7108 — extra techs repeat the annual visit only
  const totalHrs = annualR * techs + semiR + pmR;
  return {
    annualHrs: annualR,
    semiHrs: semiR,
    totalHrs,
    laborCost: totalHrs * laborCostPerHr,
    monthlyCharge: (totalHrs * billRate) / 12,
  };
}

// PM inspection calculator — legacy/index.html:7024-7046
// rows: [{ key, hrs, mins, count, freq }] where freq = visits per year (1|2|4)
export function calcPmInspection(rows, extraHrs, technicians, laborCostPerHr, billRate) {
  let deviceHrs = 0;
  for (const r of rows) {
    deviceHrs += (Number(r.count) || 0) * ((Number(r.hrs) || 0) + (Number(r.mins) || 0) / 60) * (Number(r.freq) || 1);
  }
  const deviceR = roundTo4(deviceHrs);
  const extraR = roundTo4(Number(extraHrs) || 0);
  const techs = Math.max(1, Number(technicians) || 1);
  const totalHrs = (deviceR + extraR) * techs;
  return {
    deviceHrs: deviceR,
    extraHrs: extraR,
    totalHrs,
    laborCost: totalHrs * laborCostPerHr,
    monthlyCharge: (totalHrs * billRate) / 12,
  };
}

// Main quote roll-up — legacy/index.html:4239-4330 (calc())
//
// input = {
//   systemType, siteType,
//   monthlyCosts,        // Σ of all monthly monitoring/platform line items (legacy COST_IDS, :3491,:4242)
//   inspHours,           // annual inspection/PM labor hours
//   annualSub,           // annual subcontractor cost
//   avMaint,             // annual A/V maintenance parts cost
//   svcGM, subMarkup, avMaintGM,   // fractions (0-1)
//   laborRate,           // $/hr bill rate (slider)
//   overheadRate,        // fraction of revenue or direct cost
//   ohMethod,            // 'revenue' | 'cost'
//   quotedMonthly,       // Σ manual per-site monthly rates (0 = use recommended)
// }
export function computeQuote(input, rates) {
  const laborCostPerHr = rates?.labor?.LaborCostPerHr ?? 0;
  const isTM = TM_TYPES.includes(input.systemType);

  const inspCost = input.inspHours * laborCostPerHr;                    // :4244
  const inspBilled = input.inspHours * input.laborRate;                 // :4264
  const inspCostMonthly = inspCost / 12;
  const inspBilledMonthly = inspBilled / 12;
  const subMonthly = input.annualSub / 12;

  const mDirect = input.monthlyCosts + inspCostMonthly + subMonthly + input.avMaint / 12; // :4275
  const totalCosts = mDirect * 12;                                      // :4276-4277

  // A/V maintenance billed at its own GM — :4280-4283
  const avMaintBilled = input.avMaint > 0 ? input.avMaint / (1 - input.avMaintGM) : 0;
  const avMaintRMR = avMaintBilled / 12;
  const avMaintGP = avMaintBilled - input.avMaint;

  // Subcontractor split — :4291-4295
  const monOnlyCosts = input.monthlyCosts * 12;
  const subBilled = input.annualSub * (1 + input.subMarkup);
  const subRMR = isTM ? 0 : subBilled / 12;
  const subGP = subBilled - input.annualSub;
  const subMargin = subBilled > 0 ? subGP / subBilled : null;

  // Minimum RMR floor — ported verbatim from :4298-4299.
  // NOTE(legacy bug): the legacy check compares against 'Fire'/'Burglar' but
  // systemType values are 'Fire Monitoring & Services' etc., so the floor
  // never applied. Preserved as-is so prices match the old tool exactly;
  // confirm intended behavior with the business before "fixing".
  const isCommercial = input.siteType === 'Commercial';
  const isFireOrBurglar = ['Fire', 'Burglar'].includes(input.systemType);
  const minRMR = isFireOrBurglar
    ? (isCommercial ? rates?.minRmr?.CommercialFloor ?? 0 : rates?.minRmr?.ResidentialFloor ?? 0)
    : (input.systemType === 'Two-Way Monitoring & Services' ? rates?.minRmr?.TwoWayFloor ?? 0 : 0);

  // Recommended RMR — legacy/index.html:4578-4581 (rounded up to the next DOLLAR)
  //
  // This rounded to the next $5 until Aug 2026, and this port was written against
  // that. The legacy app then changed it to whole dollars in BOTH of its copies
  // (:4581 and :5153), so it was deliberate, not a slip. Left unfixed, every quote
  // from this tool would price up to $4.99/mo above the tool estimators are using —
  // a few hundred dollars over a 36-60 month term, per site, reading as "the new
  // system is more expensive".
  //
  // Found by the parity harness (npm run parity), which is exactly the drift it
  // exists to catch: the port was correct when written and went stale underneath.
  const monRMR53 = Math.max(minRMR, calcRMR(monOnlyCosts, input.svcGM));
  const laborRMR = inspBilledMonthly;
  const rmrRaw = Math.max(minRMR, monRMR53 + subRMR + laborRMR + avMaintRMR);
  const recommendedRMR = rmrRaw > 0 ? Math.ceil(rmrRaw) : rmrRaw;

  // Manual per-site override — :4306-4310
  const rmrIsManual = input.quotedMonthly > 0 && !isTM;
  const rmrEff = rmrIsManual ? input.quotedMonthly : recommendedRMR;

  // Combined metrics — :4312-4319
  const annRev = rmrEff * 12;
  const annGP = annRev - totalCosts;
  const annOH = input.ohMethod === 'cost' ? totalCosts * input.overheadRate : annRev * input.overheadRate;
  const annNP = annGP - annOH;
  const gm = annRev > 0 ? annGP / annRev : null;
  const nm = annRev > 0 ? annNP / annRev : null;

  // Monitoring-only metrics — :4321-4324
  const monAnnRev = monRMR53 * 12;
  const monAnnGP = monAnnRev - monOnlyCosts;
  const monGM = monAnnRev > 0 ? monAnnGP / monAnnRev : null;
  const effGM = rmrIsManual && annRev > 0 ? annGP / annRev : null;    // :4433

  // Labor metrics — :4326-4328
  const laborGP = inspBilled - inspCost;
  const laborMargin = inspBilled > 0 ? laborGP / inspBilled : null;

  return {
    isTM, minRMR,
    inspCost, inspBilled, laborRMR, laborGP, laborMargin,
    monRMR: monRMR53, monOnlyCosts, monAnnRev, monAnnGP, monGM, effGM,
    subBilled, subRMR, subGP, subMargin,
    avMaintBilled, avMaintRMR, avMaintGP,
    recommendedRMR, rmrIsManual, rmrEff,
    totalCosts, annRev, annGP, annOH, annNP, gm, nm,
    hasAny: totalCosts > 0 || inspBilled > 0 || rmrIsManual,
  };
}

// SLA budget frequency conversion — legacy/index.html:8430-8459
export function slaDisplayFromMonthly(monthlyBase, freq) {
  if (freq === 'quarterly') return monthlyBase * 3;
  if (freq === 'annual') return monthlyBase * 12;
  return monthlyBase;
}
export function slaMonthlyFromDisplay(value, freq) {
  if (freq === 'quarterly') return value / 3;
  if (freq === 'annual') return value / 12;
  return value;
}

/**
 * SLA service-call rates by tier — the PUBLISHED rate card, legacy :9702-9706.
 *
 * The legacy sets the three budget rate dropdowns straight from tierRates when a tier
 * is selected:
 *
 *     var _trSel = (isEssential ? _trCfg.essential
 *                 : isPremier   ? _trCfg.premier
 *                               : _trCfg.priority) || {};
 *     regRate = _trSel.st;  ahRate = _trSel.th;  emRate = _trSel.dt;
 *
 * THIS USED TO DERIVE THE RATES INSTEAD, by multiplying straight time by the priority
 * and premier multipliers. That was transcribed from legacy :8199-8207, which computes
 * exactly that — and which the legacy assigns and then never reads again. A dead code
 * path, faithfully ported.
 *
 * The published card is not a multiplier grid and cannot be reconstructed as one:
 * emergency is a FLAT 266.03 on every tier, and Priority's time-and-a-half (230.67)
 * equals Premier's straight time. Deriving overcharged Priority and Premier
 * after-hours and emergency work by $22-$80/hr.
 *
 * Returns null when no tiers are loaded, deliberately. The alternative — falling back
 * to the multiplier model — is how the wrong numbers looked plausible for so long.
 */
export function slaRateTable(rates) {
  const rows = rates?.tiers;
  if (!Array.isArray(rows) || !rows.length) return null;

  const table = {};
  for (const row of rows) {
    const name = String(row.tier_name || row.tierName || '').toLowerCase();
    if (!name) continue;
    // straight_time is the explicit column; `rate` carries the same value and is kept
    // only so older readers do not break.
    table[name] = {
      straight: Number(row.straight_time ?? row.rate),
      timeAndHalf: Number(row.time_and_half),
      doubleTime: Number(row.double_time),
    };
  }
  return Object.keys(table).length ? table : null;
}
