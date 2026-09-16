// Reading and writing .p1est estimate files.
//
// WHY THE LEGACY'S FORMAT RATHER THAN A NICER ONE. The team has months of estimates
// sitting on OneDrive, saved by the tool they use today, and being able to open them
// is the single biggest reason to adopt this one. A new format would mean every
// estimate before cutover is unreadable by the thing that replaces it.
//
// So this reads and writes gatherEstimateData's shape (legacy/index.html:7031-7200,
// restoreEstimateData :7505-7700): a flat bag keyed by DOM element id.
//
//   { version: 2, ts, fields: {id: value}, checkboxes: {id: bool}, selects: {id: value},
//     subType, subOtherDesc, matRows: [], tmSubRows: [], rentalRows: [], ... }
//
// It is not a good format. It is the format the files are in.
//
// WHAT THIS DOES NOT CLAIM. A file written here opens in the legacy for everything
// both tools have in common, which is most of it. It is not byte-identical: the
// legacy stores panel open/closed flags and a few derived hidden inputs that have no
// equivalent once the UI is components rather than divs. Those are preserved on the
// way IN — see `passthrough` — so importing and re-exporting does not destroy them.

// Plain JavaScript only — no component imports. See estimateState.js for why: this
// module has to be loadable by a Node harness, and a .jsx import makes that
// impossible.
import {
  newAdcState, newRentalState, newRentalRow, newMaterialRow, newLaborRow,
  newTmSubRow, newSubcontractor, newEstimateDetails,
} from './estimateState.js';

const s = (v) => (v == null ? '' : String(v));
const n = (v, d = 0) => {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : d;
};

// legacy id -> path in our Alarm.com state. One table, used in both directions, so
// an import and an export cannot drift apart.
const ADC_SCALARS = [
  ['adc-base', 'base'],
  ['adc-video', 'video.value'],
  ['adc-camera-count', 'video.cameras'],
  ['adc-expansions', 'video.expansions'],
  ['adc-svrs', 'video.servers'],
  ['adc-intercom', 'video.intercom'],
  ['adc-cv-intercom-devices', 'cvIntercom.devices'],
  ['adc-cv-intercom-users', 'cvIntercom.users'],
  ['adc-access', 'access.packageValue'],
  ['adc-access-bundle', 'access.bundle'],
  ['adc-access-doors', 'access.doors'],
  ['adc-mobile-10', 'access.mobile10'],
  ['adc-mobile-100', 'access.mobile100'],
  ['adc-sensors', 'sensors'],
  ['adc-aid', 'aid'],
  ['adc-cars', 'cars'],
  ['adc-fleet', 'fleet'],
  ['adc-comms', 'comms'],
  ['adc-supervision', 'supervision'],
  ['adc-flexio', 'flexIo'],
  ['adc-cellconnector', 'cellConnector'],
  ['adc-verizon-data', 'verizonData'],
  ['adc-img-events', 'imageEvents'],
  ['adc-noonlight', 'noonlightLicenses'],
];

const ADC_FLAGS = [
  ['adc-openeye-cb', 'openEye'],
  ['adc-enterprise-wellness-cb', 'enterpriseWellness'],
  ['adc-wellness-cb', 'wellness'],
  ['adc-scheduled-arm-cb', 'scheduledArm'],
  ['adc-esc-cb', 'esc'],
  ['adc-mlesc-cb', 'mlEsc'],
  ['adc-mobile-creds-cb', 'mobileCreds'],
];

const getPath = (obj, path) =>
  path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

const setPath = (obj, path, value) => {
  const keys = path.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) cur = cur[k];
  cur[keys[keys.length - 1]] = value;
};

/** Our state -> a .p1est file the legacy can open. */
export function gatherEstimate(e) {
  const site = e.sites?.[0] || {};
  const fields = {
    custName: s(e.customer?.companyName),
    contactName: s(e.customer?.contactName),
    siteAddress: s(site.address), siteCity: s(site.city),
    siteState: s(site.state), siteZip: s(site.zip),
    'qb-site1-rate': s(site.monthlyRate),
    phoneNumber: s(e.customer?.phone), emailAddress: s(e.customer?.email),
    systemType: s(e.systemType), siteType: s(e.siteType),
    agreementName: s(e.details?.agreementName),
    estimatorName: s(e.details?.estimatorName),
    estimatorEmail: s(e.details?.estimatorEmail),
    estimateNum: s(e.details?.estimateNumber),
    notes: s(e.notes),
    inspHours: s(e.inspHours || ''),
    annualSub: s(e.sub?.annualCost),
    // A hidden total in the legacy, written by summing the parts rows (:5677-5680).
    avMaintenance: s(e.avMaintTotal || ''),
    overheadRate: s(e.overheadRate), ohMethod: s(e.ohMethod),
    svcGMSlider: s(e.svcGM), subMarkupSlider: s(e.subMarkup),
    laborRateSlider: s(e.laborRate), avMaintGMSlider: s(e.avMaintGM),
    matMarkupSlider: s(Math.round((e.matMarkup ?? 0) * 100)),
    tmSubGMSlider: s(Math.round((e.tmSubGM ?? 0) * 100)),
    matShippingCost: s(e.details?.shippingCost),
    shMarkupSlider: s(e.details?.shippingMarkup),
    matTaxRate: s(e.details?.materialTaxRate),
    rentalDelivery: s(e.rental?.delivery),
    rentalMarkup: s(e.rental?.markup),
  };
  for (const [id, path] of ADC_SCALARS) fields[id] = s(getPath(e.adcCfg || {}, path));

  const checkboxes = {
    'cb-honeywell': !!e.checks?.honeywell,
    'cb-teleguard': !!e.checks?.teleguard,
    'cb-br': !!e.checks?.br,
    'cb-sfburg': !!e.checks?.sfburg,
    'cb-ulcerts': !!e.checks?.ulcerts,
    'cb-bosch': !!e.checks?.bosch,
    'cb-alarmcom-enable': !!e.adcEnabled,
    'cb-connectone': !!e.connectOne?.enabled,
    'cb-connectone-addon': !!e.connectOne?.addon,
    'cb-alarmnet': !!e.alarmNet?.enabled,
    'gcs-other-fire': !!e.gcsChecks?.fire,
    'gcs-other-burg': !!e.gcsChecks?.burg,
    'gcs-other-res': !!e.gcsChecks?.res,
    'cb-nfpa': !!e.nfpaOn,
    'cb-pm': !!e.pmOn,
    'cb-pm-av-other': !!e.pmAv,
  };
  for (const [id, key] of ADC_FLAGS) checkboxes[id] = !!(e.adcCfg || {})[key];
  for (const [k, on] of Object.entries(e.adcCfg?.sections || {})) checkboxes[`adc-toggle-${k}`] = !!on;
  for (const [k, on] of Object.entries(e.adcCfg?.videoScope || {})) checkboxes[`adc-vs-${k}`] = !!on;
  for (const [k, on] of Object.entries(e.adcCfg?.addons || {})) checkboxes[`adc-x-${k}`] = !!on;

  const selects = {
    'alarmnet-plan': s(e.alarmNet?.plan),
    'connectone-sms': s(e.connectOne?.sms),
    'connectone-systems': s(e.connectOne?.systems),
  };
  for (const [id, path] of ADC_SCALARS) selects[id] = s(getPath(e.adcCfg || {}, path));

  return {
    // The legacy reads version 2 and ignores anything it does not recognise.
    ...(e.passthrough || {}),
    version: 2,
    ts: new Date().toISOString(),
    exportedBy: 'p1-sse (Azure)',
    fields, checkboxes, selects,
    subType: s(e.sub?.type),
    subOtherDesc: s(e.sub?.description),
    matRows: (e.rows || []).map((r) => ({ ...r, key: undefined })),
    tmSubRows: (e.tmSubRows || []).map((r) => ({ ...r, key: undefined })),
    rentalRows: (e.rental?.rows || []).map((r) => ({
      desc: s(r.desc), vendor: s(r.vendor), part: s(r.part),
      qty: n(r.qty), unit: r.unit || 'Day', cost: n(r.cost),
    })),
    rentalDelivery: n(e.rental?.delivery),
    rentalMarkup: n(e.rental?.markup, 15),
    parts: (e.avParts || []).map((p) => ({ desc: s(p.desc), unitCost: n(p.unitCost), qty: n(p.qty, 1) })),
  };
}

/**
 * A .p1est file -> a patch for our state.
 *
 * Everything is defensive. These files were written by a different program over
 * several months and several versions of it; a missing key is normal, not an error,
 * and must not take the import down with it.
 */
export function restoreEstimate(data = {}) {
  const f = data.fields || {};
  const cb = data.checkboxes || {};
  const sel = data.selects || {};
  const pick = (id) => (f[id] !== undefined ? f[id] : sel[id]);

  const adcCfg = newAdcState();
  for (const [id, path] of ADC_SCALARS) {
    const v = pick(id);
    if (v !== undefined && v !== '') setPath(adcCfg, path, v);
  }
  for (const [id, key] of ADC_FLAGS) if (cb[id] !== undefined) adcCfg[key] = !!cb[id];
  for (const [id, on] of Object.entries(cb)) {
    if (id.startsWith('adc-toggle-')) adcCfg.sections[id.slice(11)] = !!on;
    else if (id.startsWith('adc-vs-')) adcCfg.videoScope[id.slice(7)] = !!on;
    else if (id.startsWith('adc-x-')) adcCfg.addons[id.slice(6)] = !!on;
  }
  // Access has no checkbox of its own in the file — it is on when a package was
  // chosen, which is how the legacy renders it too.
  adcCfg.access.enabled = !!adcCfg.access.packageValue;

  const details = {
    ...newEstimateDetails(),
    estimateNumber: s(f.estimateNum), agreementName: s(f.agreementName),
    estimatorName: s(f.estimatorName), estimatorEmail: s(f.estimatorEmail),
    shippingCost: s(f.matShippingCost),
    shippingMarkup: f.shMarkupSlider !== undefined ? n(f.shMarkupSlider, 15) : 15,
    materialTaxRate: s(f.matTaxRate),
  };

  const rental = newRentalState();
  rental.rows = (data.rentalRows || []).map((r) => newRentalRow({
    desc: s(r.desc), vendor: s(r.vendor), part: s(r.part),
    qty: r.qty ?? 1, unit: r.unit || 'Day', cost: r.cost ?? '',
  }));
  rental.delivery = data.rentalDelivery ? String(data.rentalDelivery) : '';
  rental.markup = n(data.rentalMarkup, 15);

  const rows = (data.matRows || []).map((r) =>
    r.type === 'labor' ? newLaborRow(r) : newMaterialRow(r));

  const sub = {
    ...newSubcontractor(),
    type: s(data.subType), description: s(data.subOtherDesc), annualCost: s(f.annualSub),
  };

  // Anything the file carried that we did not read. Kept so a round trip through this
  // tool does not quietly strip a legacy estimate of the parts it understands and we
  // do not — panel open/closed state, and whatever a future version of main adds.
  const known = new Set(['version', 'ts', 'exportedBy', 'fields', 'checkboxes', 'selects',
    'subType', 'subOtherDesc', 'matRows', 'tmSubRows', 'rentalRows', 'rentalDelivery',
    'rentalMarkup', 'parts']);
  const passthrough = {};
  for (const [k, v] of Object.entries(data)) if (!known.has(k)) passthrough[k] = v;

  return {
    customer: {
      companyName: s(f.custName), contactName: s(f.contactName),
      phone: s(f.phoneNumber), email: s(f.emailAddress),
    },
    site: {
      address: s(f.siteAddress), city: s(f.siteCity),
      state: s(f.siteState), zip: s(f.siteZip),
      monthlyRate: s(f['qb-site1-rate']),
    },
    systemType: s(f.systemType),
    siteType: s(f.siteType),
    notes: s(f.notes),
    details,
    simpleInspHours: s(f.inspHours),
    sub,
    avParts: (data.parts || []).map((p) => ({ desc: s(p.desc), unitCost: p.unitCost ?? '', qty: p.qty ?? 1 })),
    adcEnabled: !!cb['cb-alarmcom-enable'],
    adcCfg,
    connectOne: {
      enabled: !!cb['cb-connectone'], addon: !!cb['cb-connectone-addon'],
      systems: sel['connectone-systems'] || 1, sms: s(sel['connectone-sms']),
    },
    alarmNet: { enabled: !!cb['cb-alarmnet'], plan: s(sel['alarmnet-plan']) },
    gcsChecks: {
      fire: !!cb['gcs-other-fire'], burg: !!cb['gcs-other-burg'], res: !!cb['gcs-other-res'],
    },
    checks: {
      honeywell: !!cb['cb-honeywell'], teleguard: !!cb['cb-teleguard'], br: !!cb['cb-br'],
      sfburg: !!cb['cb-sfburg'], ulcerts: !!cb['cb-ulcerts'], bosch: !!cb['cb-bosch'],
    },
    // Explicit booleans, not null: an imported estimate records what the estimator
    // chose, and must not silently flip when the type implies something else.
    inspOn: {
      nfpa: cb['cb-nfpa'] !== undefined ? !!cb['cb-nfpa'] : null,
      pm: cb['cb-pm'] !== undefined ? !!cb['cb-pm'] : null,
      pmAvOther: cb['cb-pm-av-other'] !== undefined ? !!cb['cb-pm-av-other'] : null,
    },
    rows,
    tmSubRows: (data.tmSubRows || []).map((r) => newTmSubRow(r)),
    rental,
    sliders: {
      svcGM: f.svcGMSlider !== undefined && f.svcGMSlider !== '' ? n(f.svcGMSlider) : null,
      subMarkup: f.subMarkupSlider !== undefined && f.subMarkupSlider !== '' ? n(f.subMarkupSlider) : null,
      avMaintGM: f.avMaintGMSlider !== undefined && f.avMaintGMSlider !== '' ? n(f.avMaintGMSlider) : null,
      laborRate: f.laborRateSlider !== undefined && f.laborRateSlider !== '' ? n(f.laborRateSlider) : null,
      overheadRate: f.overheadRate !== undefined && f.overheadRate !== '' ? n(f.overheadRate) : null,
      ohMethod: f.ohMethod === 'cost' ? 'cost' : 'revenue',
      matMarkup: f.matMarkupSlider !== undefined && f.matMarkupSlider !== '' ? n(f.matMarkupSlider) / 100 : null,
      tmSubGM: f.tmSubGMSlider !== undefined && f.tmSubGMSlider !== '' ? n(f.tmSubGMSlider) / 100 : null,
    },
    passthrough,
  };
}

/** A filename someone can find again. */
export function estimateFilename(e) {
  const parts = [e.customer?.companyName, e.details?.agreementName || e.details?.estimateNumber]
    .map((x) => String(x || '').trim()).filter(Boolean);
  const stem = (parts.join(' - ') || 'estimate').replace(/[^a-z0-9 _-]+/gi, '').slice(0, 80);
  return `${stem} ${new Date().toISOString().slice(0, 10)}.p1est`;
}
