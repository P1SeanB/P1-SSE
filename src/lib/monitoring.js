// Monthly monitoring cost — the services side of a quote.
//
// Ported from legacy/index.html:3724 (COST_IDS) and :4517, where the whole model is
// two lines:
//
//   const COST_IDS = ['gcs','alarmcom','connectone','connectone-addon',
//     'connectone-sms-val','alarmnet','bosch','access','honeywell','teleguard',
//     'br','sfburg','ulcerts','customMonCost'];
//   const mMonitoring = COST_IDS.reduce((s,id) => s + num(id), 0);
//
// Each service writes its monthly cost into its own field when enabled and zero when
// not; the total is a plain sum. That shape is worth preserving exactly, because it
// is what makes the total explainable — every dollar traces to one named service, and
// a quote that looks wrong can be read line by line.
//
// This lived inline in QuoteBuilder.jsx as a conditional expression. Moving it here
// puts it under npm run parity:monitoring, which is the difference between arithmetic
// that is checked and arithmetic that merely looks right.

// The order is the legacy's, so a breakdown reads the same way in both tools.
export const COST_KEYS = [
  'gcs', 'alarmcom', 'connectone', 'connectoneAddon', 'connectoneSms',
  'alarmnet', 'bosch', 'access', 'honeywell', 'teleguard', 'br', 'sfburg',
  'ulcerts', 'customMonCost',
];

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * GCS central-station monitoring — :4569 area, and the gcs_rate table.
 *
 * Access Hosting and Other/All Services do not carry a GCS line at all; for
 * everything else the three tiers are independently selectable and additive.
 */
export function gcsCost(selection = {}, rates = {}) {
  const g = rates.gcs || {};
  if (selection.systemType === 'Access Hosting & PM Services' ||
      selection.systemType === 'Other/All Services') {
    return 0;
  }
  return (
    (selection.fire ? num(g.FireRate) : 0) +
    (selection.burg ? num(g.BurgRate) : 0) +
    (selection.residential ? num(g.ResidentialRate) : 0)
  );
}

/** Single-family burglar is rated by site type, not by a separate control. */
export const sfBurgCost = (enabled, isCommercial, rates = {}) =>
  enabled
    ? num(isCommercial ? rates.gcs?.SfBurgCommercial : rates.gcs?.SfBurgResidential)
    : 0;

/**
 * Every monitoring line, keyed the way the legacy's COST_IDS are.
 *
 * Returns the breakdown as well as the total: the total alone cannot be checked by
 * the person quoting, and "why is this $47" is the question that actually gets asked.
 */
export function monitoringCosts(input = {}, rates = {}) {
  const misc = rates.misc || {};
  const isCommercial = input.siteType === 'Commercial';

  const parts = {
    gcs: gcsCost({ ...input.gcs, systemType: input.systemType }, rates),
    // Alarm.com arrives already totalled by src/lib/adc.js.
    alarmcom: num(input.alarmcom),
    connectone: input.connectone?.enabled ? num(input.connectone.plan) : 0,
    connectoneAddon: input.connectone?.addon ? num(input.connectone.addonValue) : 0,
    connectoneSms: input.connectone?.enabled ? num(input.connectone.smsValue) : 0,
    alarmnet: input.alarmnet?.enabled ? num(input.alarmnet.plan) : 0,
    bosch: input.bosch?.enabled ? num(input.bosch.amount) : 0,
    access: num(input.accessHosting),
    honeywell: input.honeywell ? num(misc.honeywellComm ?? 13) : 0,
    teleguard: input.teleguard ? num(misc.telguardComm ?? 25) : 0,
    br: input.buildingReports ? num(misc.buildingReports ?? 6) : 0,
    sfburg: sfBurgCost(input.sfburg, isCommercial, rates),
    ulcerts: input.ulcerts ? num(misc.ulCerts) : 0,
    // A line for anything the catalogue does not cover, with its own description.
    customMonCost: num(input.customMonCost),
  };

  const monthly = COST_KEYS.reduce((sum, key) => sum + (parts[key] || 0), 0);
  return { parts, monthly, annual: monthly * 12 };
}
