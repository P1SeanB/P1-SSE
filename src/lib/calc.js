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

  // Recommended RMR — :4300-4303 (rounded up to the next $5)
  const monRMR53 = Math.max(minRMR, calcRMR(monOnlyCosts, input.svcGM));
  const laborRMR = inspBilledMonthly;
  const rmrRaw = Math.max(minRMR, monRMR53 + subRMR + laborRMR + avMaintRMR);
  const recommendedRMR = rmrRaw > 0 ? Math.ceil(rmrRaw / 5) * 5 : rmrRaw;

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

// SLA service-call rate table — legacy/index.html:7443-7452
export function slaRateTable(rates) {
  const s = rates?.serviceCall;
  if (!s) return null;
  return {
    standard: { straight: s.StraightTimeRate, timeAndHalf: s.TimeAndHalfRate, doubleTime: s.DoubleTimeRate },
    priority: {
      straight: s.StraightTimeRate * s.PriorityMultiplier,
      timeAndHalf: s.TimeAndHalfRate * s.PriorityMultiplier,
      doubleTime: s.DoubleTimeRate * s.PriorityMultiplier,
    },
    premier: {
      straight: s.StraightTimeRate * s.PremierMultiplier,
      timeAndHalf: s.TimeAndHalfRate * s.PremierMultiplier,
      doubleTime: s.DoubleTimeRate * s.PremierMultiplier,
    },
  };
}
