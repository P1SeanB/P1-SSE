// Monitoring-cost parity — does src/lib/monitoring.js total the same as the legacy?
//
//   npm run parity:monitoring
//
// The legacy model is two lines (:3724 COST_IDS, :4517), and the harness transcribes
// them literally: each service writes its cost into a named field, and the monthly
// figure is the sum of those fields. Anything that changes that shape — a service
// that stops contributing, a rate read from the wrong place, a line double-counted —
// shows up here as a dollar difference.
import { monitoringCosts, gcsCost, sfBurgCost, COST_KEYS } from '../src/lib/monitoring.js';

const RATES = {
  gcs: {
    FireRate: 32.5, BurgRate: 26, ResidentialRate: 18,
    SfBurgCommercial: 21, SfBurgResidential: 14.5,
  },
  misc: { honeywellComm: 13, telguardComm: 25, buildingReports: 6, ulCerts: 9.5 },
};

// ── Legacy transcription — :3724, :4517 ─────────────────────────────────────
const LEGACY_COST_IDS = [
  'gcs', 'alarmcom', 'connectone', 'connectone-addon', 'connectone-sms-val',
  'alarmnet', 'bosch', 'access', 'honeywell', 'teleguard', 'br', 'sfburg',
  'ulcerts', 'customMonCost',
];

// Builds the field values the legacy DOM would hold for a given selection, then sums
// them exactly as calc() does.
function legacyMonthly(i, P1_RATES) {
  const g = P1_RATES.gcs;
  const isCommercial = i.siteType === 'Commercial';
  const noGcs = i.systemType === 'Access Hosting & PM Services' || i.systemType === 'Other/All Services';

  const fields = {
    'gcs': noGcs ? 0 : ((i.gcs.fire ? g.FireRate : 0) + (i.gcs.burg ? g.BurgRate : 0) + (i.gcs.residential ? g.ResidentialRate : 0)),
    'alarmcom': i.alarmcom || 0,
    'connectone': i.connectone.enabled ? i.connectone.plan : 0,
    'connectone-addon': i.connectone.addon ? i.connectone.addonValue : 0,
    'connectone-sms-val': i.connectone.enabled ? i.connectone.smsValue : 0,
    'alarmnet': i.alarmnet.enabled ? i.alarmnet.plan : 0,
    'bosch': i.bosch.enabled ? i.bosch.amount : 0,
    'access': i.accessHosting || 0,
    'honeywell': i.honeywell ? P1_RATES.misc.honeywellComm : 0,
    'teleguard': i.teleguard ? P1_RATES.misc.telguardComm : 0,
    'br': i.buildingReports ? P1_RATES.misc.buildingReports : 0,
    'sfburg': i.sfburg ? (isCommercial ? g.SfBurgCommercial : g.SfBurgResidential) : 0,
    'ulcerts': i.ulcerts ? P1_RATES.misc.ulCerts : 0,
    'customMonCost': i.customMonCost || 0,
  };
  return LEGACY_COST_IDS.reduce((s, id) => s + (parseFloat(fields[id]) || 0), 0);
}

const EPS = 0.005;
let checked = 0;
const mismatches = [];

const SYSTEMS = ['Fire Monitoring & Services', 'Access Hosting & PM Services', 'Other/All Services'];
const BOOLS = [false, true];

for (const systemType of SYSTEMS) {
  for (const siteType of ['Commercial', 'Residential']) {
    for (const fire of BOOLS) for (const burg of BOOLS) for (const residential of BOOLS) {
      for (const honeywell of BOOLS) for (const sfburg of BOOLS) for (const ulcerts of BOOLS) {
        for (const coEnabled of BOOLS) for (const coAddon of BOOLS) {
          const i = {
            systemType, siteType,
            gcs: { fire, burg, residential },
            alarmcom: 47.25,
            connectone: { enabled: coEnabled, plan: 12.5, addon: coAddon, addonValue: 4, smsValue: 2.75 },
            alarmnet: { enabled: true, plan: 8.95 },
            bosch: { enabled: false, amount: 0 },
            accessHosting: 15,
            honeywell, teleguard: true, buildingReports: true,
            sfburg, ulcerts,
            customMonCost: 3.5,
          };
          checked++;
          const a = legacyMonthly(i, RATES);
          const b = monitoringCosts(i, RATES).monthly;
          if (Math.abs(a - b) > EPS) mismatches.push({ i, legacy: a, ported: b });
        }
      }
    }
  }
}

const cases = [];
const named = (n, c) => cases.push([n, c]);

named('the breakdown covers every legacy COST_ID', COST_KEYS.length === LEGACY_COST_IDS.length);
// Access Hosting and Other/All carry no GCS line at all.
named('Access Hosting has no GCS line',
  gcsCost({ fire: true, burg: true, residential: true, systemType: 'Access Hosting & PM Services' }, RATES) === 0);
named('Other/All Services has no GCS line',
  gcsCost({ fire: true, systemType: 'Other/All Services' }, RATES) === 0);
named('GCS tiers are additive',
  Math.abs(gcsCost({ fire: true, burg: true, residential: true, systemType: 'Fire Monitoring & Services' }, RATES) - (32.5 + 26 + 18)) < EPS);
// Single-family burglar is rated by SITE type.
named('single-family burglar uses the commercial rate on a commercial site',
  Math.abs(sfBurgCost(true, true, RATES) - 21) < EPS);
named('single-family burglar uses the residential rate otherwise',
  Math.abs(sfBurgCost(true, false, RATES) - 14.5) < EPS);
named('single-family burglar contributes nothing when off', sfBurgCost(false, true, RATES) === 0);
// A disabled service must contribute nothing, not a stale value.
{
  const off = monitoringCosts({
    systemType: 'Fire Monitoring & Services', siteType: 'Commercial',
    gcs: {}, connectone: { enabled: false, plan: 99, addon: false, addonValue: 99, smsValue: 99 },
    alarmnet: { enabled: false, plan: 99 }, bosch: { enabled: false, amount: 99 },
  }, RATES);
  named('a disabled service contributes nothing even with a value set', off.monthly === 0);
}
// The annual figure is the monthly one, times twelve — nothing else.
{
  const r = monitoringCosts({ systemType: 'Fire', gcs: {}, connectone: {}, alarmnet: {}, bosch: {}, customMonCost: 10 }, RATES);
  named('annual is twelve monthlies', Math.abs(r.annual - r.monthly * 12) < EPS);
}

const bad = cases.filter(([, ok]) => !ok);

console.log(`\n  monitoringCosts: ${checked} input combinations checked`);
for (const [n, ok] of cases) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}`);

if (mismatches.length === 0 && bad.length === 0) {
  console.log(`\n  No drift. Monitoring costs total identically to legacy/index.html.\n`);
  process.exit(0);
}
if (mismatches.length) {
  console.log(`\n  ${mismatches.length} MISMATCH(ES):\n`);
  for (const m of mismatches.slice(0, 6)) {
    console.log(`    legacy $${m.legacy.toFixed(2)} vs ported $${m.ported.toFixed(2)}  (${m.i.systemType}, ${m.i.siteType})`);
  }
}
console.log('');
process.exit(1);
