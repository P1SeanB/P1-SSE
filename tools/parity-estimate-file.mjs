// .p1est round trip — does an estimate survive being saved and opened again?
//
//   npm run parity:estimate
//
// WHAT IS AT RISK. The team has months of estimates on OneDrive written by the legacy
// tool. Being able to open them is the single biggest reason to adopt this one, and a
// mapping mistake here does not throw: it drops a field, the estimate opens looking
// almost right, and somebody re-quotes a job from it.
//
// So this checks both directions against the legacy's own shape
// (legacy/index.html:7031 gatherEstimateData, :7607 restoreEstimateData):
//
//   ours -> file -> ours -> file     the two files must be identical
//   a hand-written LEGACY file       must arrive with its values in the right places
//
// The second matters more than the first. A round trip through our own writer proves
// self-consistency, which is the failure mode this repo has already been bitten by
// three times.
import { gatherEstimate, restoreEstimate, estimateFilename } from '../src/tabs/QuoteBuilder/estimateFile.js';
import {
  newAdcState, newMaterialRow, newLaborRow, newTmSubRow, newRentalRow,
} from '../src/tabs/QuoteBuilder/estimateState.js';

const cases = [];
const named = (name, cond) => cases.push([name, cond]);

// ── A fully populated estimate ──────────────────────────────────────────────
// Every branch of the mapping has a value, so a field dropped on either leg shows up
// as a difference rather than as two matching blanks.
const adcCfg = newAdcState();
adcCfg.base = '11.50';
adcCfg.video = { value: '8.00', type: 'per-camera', cameras: 6, expansions: '24.00', servers: 2, intercom: '' };
adcCfg.cvIntercom = { devices: 3, users: 40 };
adcCfg.access = { enabled: true, packageValue: '30.00', package: '', bundle: '26.00', doors: '8', mobile10: '5.00', mobile100: '' };
adcCfg.addons = { 'liftmaster-integration': true, locks: true, shades: false };
adcCfg.sections = { video: true, access: true, comms: false };
adcCfg.videoScope = { doorbell: true, 'onboard-rec': false };
adcCfg.sensors = '5.00'; adcCfg.aid = '3.00'; adcCfg.cars = '9.00'; adcCfg.fleet = '4.00';
adcCfg.comms = '7.00'; adcCfg.flexIo = '2.00'; adcCfg.cellConnector = '6.00';
adcCfg.verizonData = '3.50'; adcCfg.imageEvents = '1.25';
adcCfg.supervision = 'hourly'; adcCfg.noonlightLicenses = 12;
adcCfg.openEye = true; adcCfg.enterpriseWellness = false; adcCfg.wellness = true;
adcCfg.scheduledArm = true; adcCfg.esc = false; adcCfg.mlEsc = true; adcCfg.mobileCreds = true;

const original = {
  customer: { companyName: 'Acme Manufacturing', contactName: 'Dana Reyes', phone: '(555) 010-2030', email: 'dana@acme.test' },
  sites: [{ address: '400 Industrial Way', city: 'San Francisco', state: 'CA', zip: '94107', monthlyRate: '425.00' }],
  systemType: 'Fire Monitoring & Services',
  siteType: 'Commercial',
  notes: 'Riser room access via loading dock.',
  details: {
    estimateNumber: 'EST-2026-118', agreementName: 'Acme — Fire Monitoring',
    estimatorName: 'Sean Bithell', estimatorEmail: 'sean.bithell@point1.test',
    billing: { same: false, address: 'PO Box 9', city: 'Oakland', state: 'CA', zip: '94601' },
    shippingCost: '200', shippingMarkup: 15, materialTaxRate: '8.25',
  },
  inspHours: 48, avMaintTotal: 1800,
  sub: { type: 'Sprinkler', description: 'Annual backflow certification', annualCost: '4800' },
  avParts: [{ desc: 'Spare display', unitCost: 450, qty: 2 }],
  adcEnabled: true, adcCfg,
  connectOne: { enabled: false, addon: true, systems: 3, sms: '5.00' },
  alarmNet: { enabled: true, plan: '12.00' },
  gcsChecks: { fire: true, burg: false, res: true },
  checks: { honeywell: true, teleguard: false, br: true, sfburg: true, ulcerts: false, bosch: true },
  nfpaOn: true, pmOn: true, pmAv: false,
  // Built with the factories, because that is the only way a row exists in the app.
  // Hand-written partial rows made this check fail on `source: undefined -> ""` — the
  // fixture was unrealistic, not the mapping.
  rows: [
    newMaterialRow({ desc: 'FACP', cost: '1850', qty: 1, unit: 'ea', vendor: 'Graybar', partNumber: 'FX-2000', laborHrs: '6' }),
    newMaterialRow({ desc: 'FPLR cable', cost: '0.42', qty: 2500, unit: '1000ft', vendor: 'Anixter', waste: '10', costBy: 'package', pkgSize: '1000' }),
    newLaborRow({ desc: 'Commissioning', hrs: '12', rate: '120', sellPerHr: '180' }),
  ],
  tmSubRows: [newTmSubRow({ desc: 'Core drilling', cost: '1400', billTo: 'customer', pco: 'PCO-4' })],
  rental: {
    rows: [
      newRentalRow({ desc: '26ft scissor lift', vendor: 'United', part: 'Q-8841', qty: 5, unit: 'Day', cost: 200 }),
      newRentalRow({ desc: 'Boom lift', vendor: 'Sunbelt', part: '', qty: 2, unit: 'Week', cost: 950 }),
    ],
    delivery: '100', markup: 15,
  },
  matMarkup: 0.69, tmSubGM: 0.42,
  svcGM: 53, subMarkup: 20, avMaintGM: 53, laborRate: 180, overheadRate: 0.28, ohMethod: 'cost',
  passthrough: { subPanelOpen: true, matPanelOpen: false, somethingMainAddedLater: { a: 1 } },
};

// ── ours -> file -> ours -> file ────────────────────────────────────────────
const file1 = gatherEstimate(original);
const back = restoreEstimate(file1);

// Rebuild the caller's shape from the patch restoreEstimate returns, the way
// QuoteBuilder does when it imports.
const rebuilt = {
  customer: back.customer,
  sites: [back.site],
  systemType: back.systemType, siteType: back.siteType, notes: back.notes,
  details: back.details,
  inspHours: original.inspHours, avMaintTotal: original.avMaintTotal,
  sub: back.sub, avParts: back.avParts,
  adcEnabled: back.adcEnabled, adcCfg: back.adcCfg,
  connectOne: back.connectOne, alarmNet: back.alarmNet,
  gcsChecks: back.gcsChecks, checks: back.checks,
  nfpaOn: back.inspOn.nfpa, pmOn: back.inspOn.pm, pmAv: back.inspOn.pmAvOther,
  rows: back.rows, tmSubRows: back.tmSubRows, rental: back.rental,
  matMarkup: back.sliders.matMarkup, tmSubGM: back.sliders.tmSubGM,
  svcGM: back.sliders.svcGM, subMarkup: back.sliders.subMarkup,
  avMaintGM: back.sliders.avMaintGM, laborRate: back.sliders.laborRate,
  overheadRate: back.sliders.overheadRate, ohMethod: back.sliders.ohMethod,
  passthrough: back.passthrough,
};
const file2 = gatherEstimate(rebuilt);

// `ts` is the moment of writing and is expected to differ.
const strip = (f) => { const { ts, ...rest } = f; return rest; };
const diffs = [];
const walk = (a, b, path = '') => {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const p = path ? `${path}.${k}` : k;
    const x = a?.[k]; const y = b?.[k];
    if (x && y && typeof x === 'object' && typeof y === 'object') walk(x, y, p);
    else if (JSON.stringify(x) !== JSON.stringify(y)) diffs.push(`${p}: ${JSON.stringify(x)} -> ${JSON.stringify(y)}`);
  }
};
walk(strip(file1), strip(file2));
named('an estimate survives save -> open -> save unchanged', diffs.length === 0);

// ── Named checks on the file itself ─────────────────────────────────────────
named('the file is written in the legacy shape (version 2, fields/checkboxes/selects)',
  file1.version === 2 && !!file1.fields && !!file1.checkboxes && !!file1.selects);

named('rental rows are written with description, vendor, qty, unit and cost',
  file1.rentalRows.length === 2
  && file1.rentalRows[0].desc === '26ft scissor lift'
  && file1.rentalRows[0].unit === 'Day' && file1.rentalRows[0].qty === 5
  && file1.rentalRows[1].unit === 'Week');

named('the rental markup and pickup charge are written',
  file1.rentalMarkup === 15 && file1.rentalDelivery === 100);

named('Alarm.com add-ons are written as adc-x-* checkboxes',
  file1.checkboxes['adc-x-liftmaster-integration'] === true
  && file1.checkboxes['adc-x-locks'] === true
  && file1.checkboxes['adc-x-shades'] === false);

named('Alarm.com section toggles and video scope are written',
  file1.checkboxes['adc-toggle-video'] === true
  && file1.checkboxes['adc-vs-doorbell'] === true);

named('the subcontractor type and its description are written',
  file1.subType === 'Sprinkler' && file1.subOtherDesc === 'Annual backflow certification');

named('the inspection toggles are written',
  file1.checkboxes['cb-nfpa'] === true && file1.checkboxes['cb-pm'] === true
  && file1.checkboxes['cb-pm-av-other'] === false);

// Keys the legacy writes and we do not read must not be destroyed by a round trip.
named('unknown keys from the source file survive a round trip',
  file2.subPanelOpen === true && file2.somethingMainAddedLater?.a === 1);

// ── A hand-written LEGACY file ──────────────────────────────────────────────
// Not produced by our own writer: this is the shape a file on OneDrive actually has,
// including a rental section from main af1427c.
const legacyFile = {
  version: 2,
  ts: '2026-09-02T17:41:08.221Z',
  fields: {
    custName: 'Harbor Freight Depot', contactName: 'Lee Park',
    siteAddress: '77 Dock St', siteCity: 'Oakland', siteState: 'CA', siteZip: '94607',
    phoneNumber: '(555) 777-1212', emailAddress: 'lee@harbor.test',
    systemType: 'Burglar Monitoring & Services', siteType: 'Commercial',
    agreementName: 'Harbor — Burg', estimatorName: 'Sean Bithell',
    estimatorEmail: 'sean.bithell@point1.test', estimateNum: 'EST-2026-090',
    notes: 'Gate code 4417.',
    inspHours: '16', annualSub: '2400', avMaintenance: '0',
    overheadRate: '0.3', ohMethod: 'revenue',
    svcGMSlider: '58', subMarkupSlider: '25', laborRateSlider: '195',
    avMaintGMSlider: '50', matMarkupSlider: '72', tmSubGMSlider: '45',
    matShippingCost: '150', shMarkupSlider: '20', matTaxRate: '9.25',
    'adc-base': '13.95', 'adc-video': '6.00', 'adc-camera-count': '4',
    'adc-supervision': 'six', 'adc-noonlight': '6',
  },
  checkboxes: {
    'cb-alarmcom-enable': true, 'cb-honeywell': true, 'cb-bosch': false,
    'gcs-other-fire': false, 'gcs-other-burg': true, 'gcs-other-res': false,
    'cb-nfpa': false, 'cb-pm': true, 'cb-pm-av-other': false,
    'adc-x-locks': true, 'adc-toggle-video': true, 'adc-vs-doorbell': true,
    'adc-openeye-cb': true,
  },
  selects: { 'alarmnet-plan': '9.00', 'connectone-sms': '3.00', 'connectone-systems': '2' },
  subType: 'Locksmith', subOtherDesc: '',
  matRows: [
    { type: 'material', desc: 'Keypad', cost: '210', qty: 3, unit: 'ea' },
    { type: 'labor', desc: 'Programming', hrs: '4', rate: '120', sellPerHr: '180' },
  ],
  tmSubRows: [{ desc: 'Locksmith call', cost: '650', billTo: 'customer', pco: '' }],
  rentalRows: [{ desc: '19ft scissor lift', vendor: 'United', part: '', qty: 3, unit: 'Day', cost: 175 }],
  rentalDelivery: 90,
  rentalMarkup: 20,
  parts: [],
  matPanelOpen: true,
  tmSubPanelOpen: true,
};

const r = restoreEstimate(legacyFile);

named('a legacy file restores the customer and site',
  r.customer.companyName === 'Harbor Freight Depot' && r.site.city === 'Oakland'
  && r.site.zip === '94607');

named('a legacy file restores the estimate identity',
  r.details.estimateNumber === 'EST-2026-090' && r.details.estimatorName === 'Sean Bithell');

named('a legacy file restores the one-time charges as percentages',
  r.details.shippingCost === '150' && r.details.shippingMarkup === 20
  && r.details.materialTaxRate === '9.25');

named('a legacy file restores material and labour rows with usable keys',
  r.rows.length === 2 && r.rows[0].type === 'material' && r.rows[1].type === 'labor'
  && r.rows[0].key && r.rows[1].key && r.rows[0].key !== r.rows[1].key);

named('a legacy file restores rental rows, markup and pickup charge',
  r.rental.rows.length === 1 && r.rental.rows[0].desc === '19ft scissor lift'
  && r.rental.rows[0].qty === 3 && r.rental.rows[0].cost === 175
  && r.rental.markup === 20 && r.rental.delivery === '90');

named('a legacy file restores the Alarm.com package',
  r.adcEnabled === true && r.adcCfg.base === '13.95'
  && r.adcCfg.video.value === '6.00' && r.adcCfg.video.cameras === '4'
  && r.adcCfg.supervision === 'six' && r.adcCfg.noonlightLicenses === '6'
  && r.adcCfg.addons.locks === true && r.adcCfg.sections.video === true
  && r.adcCfg.videoScope.doorbell === true && r.adcCfg.openEye === true);

named('a legacy file restores the subcontractor',
  r.sub.type === 'Locksmith' && r.sub.annualCost === '2400');

// THE ONE THAT MATTERS MOST for an imported estimate: the toggles record what the
// estimator chose, and must not be re-derived from the estimate type. This file is a
// Burglar estimate with NFPA explicitly OFF.
named('an imported estimate keeps the estimator\'s inspection choices, not the type\'s',
  r.inspOn.nfpa === false && r.inspOn.pm === true && r.inspOn.pmAvOther === false);

named('sliders come back as numbers, and as fractions where src/lib expects fractions',
  r.sliders.svcGM === 58 && r.sliders.laborRate === 195 && r.sliders.overheadRate === 0.3
  && Math.abs(r.sliders.matMarkup - 0.72) < 1e-9 && Math.abs(r.sliders.tmSubGM - 0.45) < 1e-9);

named('a legacy file\'s unrecognised keys are kept for the next save',
  r.passthrough.matPanelOpen === true && r.passthrough.tmSubPanelOpen === true);

// An empty or truncated file must not throw — these arrive from real folders.
named('an empty object imports without throwing', (() => {
  try { const e = restoreEstimate({}); return e.rows.length === 0 && e.rental.rows.length === 0; }
  catch { return false; }
})());
named('an undefined file imports without throwing', (() => {
  try { restoreEstimate(); return true; } catch { return false; }
})());

named('the filename identifies the estimate',
  estimateFilename(original).startsWith('Acme Manufacturing - Acme  Fire Monitoring')
  && estimateFilename(original).endsWith('.p1est'));

const bad = cases.filter(([, ok]) => !ok);

console.log(`\n  .p1est round trip: ${cases.length} check(s)`);
for (const [name, ok] of cases) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);

if (diffs.length) {
  console.log(`\n  ${diffs.length} field(s) changed across the round trip:`);
  for (const d of diffs.slice(0, 12)) console.log(`    ${d}`);
  if (diffs.length > 12) console.log(`    … and ${diffs.length - 12} more`);
}

if (bad.length) { console.log(''); process.exit(1); }
console.log('\n  No loss. An estimate survives being saved and opened again.\n');
