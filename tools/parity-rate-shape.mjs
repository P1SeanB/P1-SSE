// Does the /api/rates payload reach the pricing code in the shape it reads?
//
//   npm run parity:shape
//
// THE GAP THIS CLOSES. Every other harness feeds the pricing functions a fixture
// written by hand, so they prove the arithmetic and say nothing about whether the
// running app supplies those inputs. It did not: the API returns PostgreSQL column
// names (labor_cost_per_hr, fire_rate) and the code reads legacy config names
// (LaborCostPerHr, FireRate), which is undefined at runtime and falls back to a
// development default. Plausible numbers, quietly wrong, and green tests either way.
//
// So this harness starts from a payload shaped exactly like the API's response and
// asserts that every key the application actually reads arrives with a real value.
//
// The expected list is derived from the source, not from memory:
//   grep -rhoE "rates\??\.[a-zA-Z]+|\b(labor|misc|g|gcs)\.[A-Za-z_]+" src/
import { shapeRates } from '../src/api-client/shape-rates.js';

// A response in the API's own vocabulary. Values are STRINGS because node-postgres
// returns numeric columns as strings — if the adapter forgets to convert, a
// comparison like `rate > 5` silently reads false and this fixture catches it.
const API_PAYLOAD = {
  rateProfileId: 2,
  version: 2,
  labor: {
    labor_cost_per_hr: '120.00', labor_bill_default: '180.00', labor_sell_default: '177.44',
    svc_gm: '53.00', sub_markup: '20.00', av_maint_gm: '53.00', mat_markup: '69.00',
    tm_sub_gm: '42.00', overhead_rate: '0.28',
  },
  serviceCall: {
    straight_time_rate: '177.44', time_and_half_rate: '219.87', double_time_rate: '266.03',
    priority_multiplier: '1.20', premier_multiplier: '1.30',
  },
  monitoring: { base_rate: '6.00', addon_rate: '5.00' },
  door: { sacp_rate: '3.25', standard_rate: '2.00' },
  doorBundles: [{ bundle_type: 'SACP', min_doors: 1, max_doors: 8, price: '26.00' }],
  video: { expansion_base_rate: '24.00', server_rate: '6.50' },
  gcs: {
    fire_rate: '12.00', burg_rate: '10.50', residential_rate: '5.00', two_way_rate: '5.00',
    sf_burg_residential: '5.00', sf_burg_commercial: '8.00',
  },
  minRmr: { commercial_floor: '45.00', residential_floor: '40.00', two_way_floor: '15.00' },
  misc: { ulCerts: '12.00', pmVisitRate: '177.44', honeywellComm: '13.00', telguardComm: '25.00', buildingReports: '6.00' },
  tiers: [{ tier_name: 'essential', rate: '177.44', straight_time: '177.44' }],
  dropdownOptions: { 'adc-base': [{ value: '11.50', label: 'Commercial', price: 11.5 }] },
  adc: { packages: [{ id: 'commercial', cost: 11.5 }], addOns: [], supervision: {}, tiers: {} },
};

// path -> the value it must carry. Every entry is a read that exists in src/ today.
const REQUIRED = [
  ['labor.LaborCostPerHr', 120],
  ['labor.LaborBillDefault', 180],
  ['labor.LaborSellDefault', 177.44],
  ['labor.SvcGM', 53],
  ['labor.SubMarkup', 20],
  ['labor.AvMaintGM', 53],
  ['labor.MatMarkup', 69],
  ['labor.TmSubGM', 42],
  ['labor.OverheadRate', 0.28],
  ['gcs.FireRate', 12],
  ['gcs.BurgRate', 10.5],
  ['gcs.ResidentialRate', 5],
  ['gcs.TwoWayRate', 5],
  ['gcs.SfBurgCommercial', 8],
  ['gcs.SfBurgResidential', 5],
  ['minRmr.CommercialFloor', 45],
  ['minRmr.ResidentialFloor', 40],
  ['minRmr.TwoWayFloor', 15],
  ['monitoring.BaseRate', 6],
  ['monitoring.AddonRate', 5],
  ['serviceCall.StraightTimeRate', 177.44],
  ['serviceCall.TimeAndHalfRate', 219.87],
  ['serviceCall.DoubleTimeRate', 266.03],
  ['serviceCall.PriorityMultiplier', 1.2],
  ['serviceCall.PremierMultiplier', 1.3],
  ['doorRateSACP', 3.25],
  ['doorRateStd', 2],
  ['videoExpansionBase', 24],
  ['videoSvr', 6.5],
  ['pmVisitRate', 177.44],
  ['misc.ulCerts', '12.00'],
  ['misc.honeywellComm', '13.00'],
  ['misc.telguardComm', '25.00'],
  ['misc.buildingReports', '6.00'],   // misc passes through untouched — it is already keyed by name
];

const read = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

const shaped = shapeRates(API_PAYLOAD);
const failures = [];

for (const [path, expected] of REQUIRED) {
  const got = read(shaped, path);
  if (got === undefined) { failures.push(`${path} is MISSING — the app would fall back to a default`); continue; }
  if (typeof expected === 'number' && typeof got !== 'number') {
    failures.push(`${path} is ${typeof got} "${got}", expected a number — string rates break comparisons`);
    continue;
  }
  if (typeof expected === 'number' ? Math.abs(got - expected) > 0.0001 : got !== expected) {
    failures.push(`${path} is ${got}, expected ${expected}`);
  }
}

// The tree consumed by src/lib/adc.js has to survive untouched: it is a vendor sheet,
// not something to rename.
if (!shaped.adc || !Array.isArray(shaped.adc.packages)) {
  failures.push('adc tree did not survive shaping — every Alarm.com charge would be zero');
}
if (!shaped.dropdownOptions || !shaped.dropdownOptions['adc-base']) {
  failures.push('dropdownOptions did not survive shaping — every dropdown would be empty');
}

console.log(`\n  rate shape: ${REQUIRED.length} key(s) checked against an API-shaped payload`);
if (failures.length) {
  console.log(`\n  ${failures.length} PROBLEM(S):`);
  for (const f of failures) console.log(`    - ${f}`);
  console.log('');
  process.exit(1);
}
console.log('  No drift. Every rate the app reads arrives with a real value.\n');
