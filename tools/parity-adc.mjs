// Alarm.com pricing parity — does src/lib/adc.js price identically to the legacy?
//
//   npm run parity:adc
//
// Transcribed independently from legacy/index.html:4322-4485 (adcCalc), so the two
// implementations can actually disagree. Writing the check by calling the port would
// prove only that the port equals itself.
//
// Alarm.com is the largest pricing surface main has added — 68 controls — and every
// line of it postdates the original port. It is the most likely place for a quote to
// come out wrong, which is why it gets its own harness rather than a few cases bolted
// onto the quote one.
import { computeAdc, isCommercialBase, hasCvIntercom } from '../src/lib/adc.js';

// A configuration shaped like P1_RATES.adc, with two packages so the per-package
// supervision and Noonlight tables are actually exercised — a single-package fixture
// would pass even if packageIdForBase were broken.
const RATES = {
  videoExpansionBase: 24.0,
  videoSvr: 6.5,
  doorRateSACP: 3.25,
  doorRateStd: 2.0,
  icdRate: 1.25,
  adc: {
    packages: [
      { id: 'commercial', cost: 11.5 },
      { id: 'commercial-plus', cost: 13.95 },
      { id: 'residential', cost: 4.95 },
    ],
    supervision: {
      sixHour: { commercial: 3.0, 'commercial-plus': 2.5, default: 4.0 },
      hourly: { commercial: 6.0, 'commercial-plus': 5.0, default: 8.0 },
    },
    tiers: {
      noonlightLicenses: { freeUnits: { 'commercial-plus': 5 }, perUnit: 2 },
    },
    liftmasterSurcharge: 1.75,
    // Covers all four shapes the real sheet contains, because each fails differently:
    //   0            included on that package — must NOT fall through to default
    //   differing    the ordinary per-package case
    //   null         withdrawn there: hidden and force-unchecked
    //   no default   withdrawn everywhere except the packages listed
    addOns: [
      { id: 'locks',       prices: { commercial: 0, 'commercial-plus': 0, default: 1.5 } },
      { id: 'thermostats', prices: { 'commercial-plus': 0, default: 1.25 } },
      { id: 'lights',      prices: { commercial: null, default: 1.25 } },
      { id: 'liftmaster',  prices: { default: 2.5 } },
      { id: 'solar',       prices: { 'commercial-plus': 3.0 } },
    ],
  },
};

// ── Legacy transcription — legacy/index.html:4322-4485 ──────────────────────
function legacyAdcTotal(i, P1_RATES) {
  let total = 0;

  const baseVal = parseFloat(i.base) || 0;
  total += baseVal;                                                    // :4324

  // Video — :4380-4394
  const videoVal = parseFloat(i.video?.value) || 0;
  const isFlat = i.video?.type === 'flat' || videoVal === 0;
  const isExpansion = i.video?.type === 'expansion';
  const isPerCam = videoVal > 0 && !isFlat && !isExpansion;
  if (isExpansion) {
    const expansionCost2 = parseFloat(i.video?.expansions) || 0;
    const intercom2 = parseFloat(i.video?.intercom) || 0;
    const svrs2 = parseInt(i.video?.servers, 10) || 0;
    const vBase2 = i.video?.hasOwnBase ? videoVal : P1_RATES.videoExpansionBase;
    total += vBase2 + expansionCost2 + svrs2 * P1_RATES.videoSvr + intercom2;
  } else if (isPerCam) {
    total += videoVal * Math.max(1, parseInt(i.video?.cameras, 10) || 1);
  } else {
    total += videoVal;
  }

  // Commercial Video intercom — :4396-4401
  const isCVIntercom = parseFloat(videoVal) === 1.5 || parseFloat(videoVal) === 3.1;
  if (isCVIntercom) {
    const cvDevices = parseInt(i.cvIntercom?.devices, 10) || 0;
    const cvUsers = parseInt(i.cvIntercom?.users, 10) || 0;
    total += cvDevices * (P1_RATES.icdRate != null ? P1_RATES.icdRate : 1.25);
    total += Math.ceil(cvUsers / 5) * 1.25;
  }

  // Access — :4405-4412
  if (i.access?.enabled) {
    total += (parseFloat(i.access?.bundle) || 0)
           + (parseFloat(i.access?.doors) || 0)
           + (parseFloat(i.access?.mobile10) || 0)
           + (parseFloat(i.access?.mobile100) || 0);
  } else {
    total += parseFloat(i.access?.packageValue) || 0;
  }

  // Checked add-ons — :4416
  // Add-ons — :15741-15745 (priceFor) and :15755-15771 (reprice).
  //
  // The legacy writes each package's price onto the checkbox and then sums the
  // checkbox values at :4416. Transcribed here as 'resolve the id against the
  // selected package', which is what those two steps amount to. A null price means
  // the row is hidden AND unchecked (:15760-15763), so it contributes nothing.
  const addonPkg = (P1_RATES.adc?.packages || [])
    .find((p) => Math.abs(parseFloat(p.cost) - baseVal) < 0.005);
  const addonPkgId = addonPkg ? addonPkg.id : null;
  for (const id of i.addons || []) {
    const a = (P1_RATES.adc?.addOns || []).find((x) => x.id === id);
    if (!a) continue;
    const pr = Object.prototype.hasOwnProperty.call(a.prices || {}, addonPkgId)
      ? a.prices[addonPkgId]
      : (Object.prototype.hasOwnProperty.call(a.prices || {}, 'default') ? a.prices.default : null);
    if (pr === null || pr === undefined) continue;
    total += parseFloat(pr) || 0;
  }

  total += parseFloat(i.sensors) || 0;                                  // :4440
  total += parseFloat(i.aid) || 0;                                      // :4442
  total += (parseFloat(i.cars) || 0) + (parseFloat(i.fleet) || 0);      // :4444
  total += parseFloat(i.comms) || 0;                                    // :4447

  // Phase 2 tiers — :4448-4451
  for (const v of [i.flexIo, i.cellConnector, i.verizonData, i.imageEvents]) {
    total += parseFloat(v) || 0;
  }

  // Supervision + Noonlight — :4453-4472
  const adcCfg = P1_RATES.adc || null;
  if (adcCfg) {
    let p2PkgId = null;
    (adcCfg.packages || []).some((p) => {
      if (Math.abs(p.cost - baseVal) < 0.005) { p2PkgId = p.id; return true; }
      return false;
    });
    const p2Pick = (tbl) =>
      tbl ? ((p2PkgId && Object.prototype.hasOwnProperty.call(tbl, p2PkgId)) ? tbl[p2PkgId] : tbl.default) : null;

    const sup = adcCfg.supervision || {};
    if (i.supervision === 'six') total += p2Pick(sup.sixHour) || 0;
    else if (i.supervision === 'hourly') total += p2Pick(sup.hourly) || 0;

    const nlt = (adcCfg.tiers || {}).noonlightLicenses;
    if (nlt) {
      const nlQty = parseInt(i.noonlightLicenses, 10) || 0;
      const nlFree = (nlt.freeUnits && p2PkgId && Object.prototype.hasOwnProperty.call(nlt.freeUnits, p2PkgId))
        ? nlt.freeUnits[p2PkgId] : 0;
      total += Math.max(0, nlQty - nlFree) * (nlt.perUnit || 2);
    }
  }

  // LiftMaster — :4475-4478
  const lmAmt = adcCfg && adcCfg.liftmasterSurcharge != null ? adcCfg.liftmasterSurcharge : 0;
  if (i.liftmasterIntegration && lmAmt) total += lmAmt;

  return total;
}

// ── Grid ────────────────────────────────────────────────────────────────────
const BASES = [0, 4.95, 11.5, 13.95];
const VIDEOS = [
  { value: 0, type: 'flat' },
  { value: 9.99, type: 'flat' },
  { value: 1.5, type: 'perCamera', cameras: 4 },
  { value: 3.1, type: 'perCamera', cameras: 1 },
  { value: 2.25, type: 'perCamera', cameras: 12 },
  { value: 0, type: 'expansion', expansions: 15, servers: 2, intercom: 4.5 },
  { value: 31.0, type: 'expansion', hasOwnBase: true, expansions: 0, servers: 0, intercom: 0 },
];
const ACCESSES = [
  { enabled: false, packageValue: 0 },
  { enabled: false, packageValue: 18.5 },
  { enabled: true, bundle: 25, doors: 6.5, mobile10: 2, mobile100: 0 },
];
const SUPERVISIONS = [null, 'six', 'hourly'];
const NOONLIGHT = [0, 3, 8];
// Sets chosen so every package sees at least one included (0), one chargeable and one
// withdrawn (null) add-on.
const ADDON_SETS = [
  [],
  ['locks', 'thermostats'],
  ['lights', 'solar', 'liftmaster'],
  ['locks', 'lights', 'thermostats', 'solar', 'liftmaster'],
];

let checked = 0;
const mismatches = [];

for (const base of BASES) {
  for (const video of VIDEOS) {
    for (const access of ACCESSES) {
      for (const supervision of SUPERVISIONS) {
        for (const noonlightLicenses of NOONLIGHT) {
          for (const liftmasterIntegration of [false, true]) {
           for (const addons of ADDON_SETS) {
            const input = {
              base,
              video,
              cvIntercom: { devices: 3, users: 12 },
              access,
              addons,
              sensors: 4.0, aid: 1.25, cars: 3.0, fleet: 1.5, comms: 8.0,
              flexIo: 2.5, cellConnector: 1.0, verizonData: 6.0, imageEvents: 0.75,
              supervision, noonlightLicenses, liftmasterIntegration,
            };
            checked++;
            const legacy = legacyAdcTotal(input, RATES);
            const ported = computeAdc(input, RATES).total;
            if (Math.abs(legacy - ported) > 0.005) {
              mismatches.push({ input, legacy, ported });
            }
           }
          }
        }
      }
    }
  }
}

// Branch predicates the component relies on to show and hide fields. A wrong answer
// here does not change a total in this harness — it changes which fields the
// estimator can see, which is how a charge silently disappears from a quote.
const predicates = [
  ['isCommercialBase(11.50)', isCommercialBase(11.5), true],
  ['isCommercialBase(13.95)', isCommercialBase(13.95), true],
  ['isCommercialBase(4.95)', isCommercialBase(4.95), false],
  ['isCommercialBase(0)', isCommercialBase(0), false],
  ['hasCvIntercom(1.50)', hasCvIntercom(1.5), true],
  ['hasCvIntercom(3.10)', hasCvIntercom(3.1), true],
  ['hasCvIntercom(2.25)', hasCvIntercom(2.25), false],
];
const badPredicates = predicates.filter(([, got, want]) => got !== want);

console.log(`\n  computeAdc: ${checked} input combinations checked`);
for (const [name, got, want] of predicates) {
  console.log(`  ${got === want ? 'ok  ' : 'FAIL'} ${name} → ${got} (expected ${want})`);
}

if (mismatches.length === 0 && badPredicates.length === 0) {
  console.log(`\n  No drift. Alarm.com prices identically to legacy/index.html.\n`);
  process.exit(0);
}

console.log(`\n  ${mismatches.length} pricing MISMATCH(ES):\n`);
for (const m of mismatches.slice(0, 10)) {
  console.log(`    legacy $${m.legacy.toFixed(2)} vs ported $${m.ported.toFixed(2)}`);
  console.log(`      base ${m.input.base} · video ${m.input.video.type}/${m.input.video.value}` +
              ` · access ${m.input.access.enabled ? 'on' : 'off'} · sup ${m.input.supervision}` +
              ` · noonlight ${m.input.noonlightLicenses} · lm ${m.input.liftmasterIntegration}`);
}
if (mismatches.length > 10) console.log(`    … and ${mismatches.length - 10} more`);
console.log('');
process.exit(1);
