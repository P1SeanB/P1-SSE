// Turn the /api/rates payload into the shape the pricing code expects.
//
// WHY THIS IS NEEDED AT ALL. The API returns rows straight out of PostgreSQL, so its
// keys are column names: labor_cost_per_hr, fire_rate, sacp_rate. Every consumer —
// src/lib/calc.js, src/lib/adc.js, and the tab components — was written against the
// legacy config's vocabulary instead: LaborCostPerHr, FireRate, doorRateSACP. Nothing
// translated between them, so every one of those reads was undefined at runtime.
//
// That did not fail loudly. It fell back:
//
//   labor.OverheadRate    -> undefined -> 0.1   while the real profile says 0.28
//   labor.SubMarkup       -> undefined -> 25    while the real profile says 20
//   labor.AvMaintGM       -> undefined -> 45    while the real profile says 53
//   labor.LaborBillDefault-> undefined -> 100   while the real profile says 180
//   labor.LaborCostPerHr  -> undefined -> 0     inspection labour priced at $0/hr
//   g.FireRate and friends-> undefined -> 0     GCS monitoring priced at $0
//
// Plausible numbers, quietly wrong, on every quote. The app looked like it was
// pricing from the imported rates and was pricing from defaults invented during
// development.
//
// AND PARITY COULD NOT SEE IT. tools/parity*.mjs feed the pricing functions fixtures
// written in the legacy vocabulary — labor: { LaborCostPerHr: 48 } — so they prove
// the arithmetic is right for a shape the running app never produced. The harness and
// the runtime disagreed about the input, and both were internally consistent.
//
// So this module is the single seam where the two vocabularies meet, and the fixture
// shape is the target: whatever parity validates is what the app must receive.
//
// The map is EXPLICIT rather than a snake_case-to-PascalCase converter. A mechanical
// one gets svc_gm wrong (SvcGm, not SvcGM), and av_maint_gm, tm_sub_gm and sacp_rate
// with it — acronyms do not survive a naive transform, and a silently misspelled key
// reintroduces exactly the bug this exists to fix.

// PostgreSQL returns numeric columns as STRINGS to avoid precision loss. Arithmetic on
// them coerces, but comparisons do not: '12.00' > 5 is false. Converting here means no
// consumer has to remember.
const n = (v) => (v === null || v === undefined || v === '' ? undefined : Number(v));

function group(row, map) {
  const out = {};
  if (!row) return out;
  for (const [column, key] of Object.entries(map)) {
    const value = n(row[column]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

const LABOR = {
  labor_cost_per_hr: 'LaborCostPerHr',
  labor_bill_default: 'LaborBillDefault',
  labor_sell_default: 'LaborSellDefault',
  svc_gm: 'SvcGM',
  sub_markup: 'SubMarkup',
  av_maint_gm: 'AvMaintGM',
  mat_markup: 'MatMarkup',
  tm_sub_gm: 'TmSubGM',
  overhead_rate: 'OverheadRate',
};

const GCS = {
  fire_rate: 'FireRate',
  burg_rate: 'BurgRate',
  residential_rate: 'ResidentialRate',
  two_way_rate: 'TwoWayRate',
  sf_burg_residential: 'SfBurgResidential',
  sf_burg_commercial: 'SfBurgCommercial',
};

const MIN_RMR = {
  commercial_floor: 'CommercialFloor',
  residential_floor: 'ResidentialFloor',
  two_way_floor: 'TwoWayFloor',
};

const MONITORING = {
  base_rate: 'BaseRate',
  addon_rate: 'AddonRate',
};

const SERVICE_CALL = {
  straight_time_rate: 'StraightTimeRate',
  time_and_half_rate: 'TimeAndHalfRate',
  double_time_rate: 'DoubleTimeRate',
  priority_multiplier: 'PriorityMultiplier',
  premier_multiplier: 'PremierMultiplier',
};

/**
 * @param {object} payload the raw /api/rates body
 * @returns {object} rates in the vocabulary src/lib and the tabs read
 */
export function shapeRates(payload) {
  const p = payload || {};
  const misc = p.misc || {};

  return {
    // Passed through unchanged — already in the right shape and vocabulary.
    rateProfileId: p.rateProfileId,
    version: p.version,
    adc: p.adc || null,
    dropdownOptions: p.dropdownOptions || {},
    doorBundles: p.doorBundles || [],
    tiers: p.tiers || [],
    misc,

    labor: group(p.labor, LABOR),
    gcs: group(p.gcs, GCS),
    minRmr: group(p.minRmr, MIN_RMR),
    monitoring: group(p.monitoring, MONITORING),
    serviceCall: group(p.serviceCall, SERVICE_CALL),

    // Flat legacy names. src/lib/adc.js reads these off the top level rather than from
    // a group, because that is where the legacy config kept them.
    doorRateSACP: n(p.door?.sacp_rate),
    doorRateStd: n(p.door?.standard_rate),
    videoExpansionBase: n(p.video?.expansion_base_rate),
    videoSvr: n(p.video?.server_rate),

    // misc_rate is a key/value table, so these already carry their legacy names.
    pmVisitRate: n(misc.pmVisitRate),
    // Intercom device rate. Not a column and not in the exported config either, so it
    // is undefined until someone adds it — adc.js treats that as 0, which matches the
    // legacy when the key is absent. Left here so the omission is visible rather than
    // looking like an oversight in adc.js.
    icdRate: n(misc.icdRate),
  };
}
