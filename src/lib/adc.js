// Alarm.com monthly pricing.
//
// Ported from legacy/index.html:4196-4487 — adcAccessCalc, adcVideoCalc and adcCalc.
// In the legacy this is ~290 lines of DOM reads, writes and visibility toggles with
// the arithmetic threaded through it. Here it is a pure function: inputs in, a
// monthly figure and its breakdown out. The visibility rules are the component's
// job (src/tabs/QuoteBuilder/Adc.jsx); pricing is this file's, and only this file's.
//
// That split is the point. In the legacy, changing what a field looks like and
// changing what it costs are the same edit, which is how a rounding change slipped
// into two copies of the RMR formula unnoticed. Here a pricing change is a change to
// a tested function, covered by npm run parity.
//
// RATES come from P1_RATES.adc (the app_rates config blob in Supabase, moving to the
// rate tables). Shape used here:
//   adc.packages[]                    { id, cost } — resolves which package is selected
//   adc.supervision.sixHour/.hourly   { <packageId>: amount, default: amount }
//   adc.tiers.noonlightLicenses       { freeUnits: { <packageId>: n }, perUnit }
//   adc.liftmasterSurcharge           number
//   videoExpansionBase, videoSvr      top-level rate values
//   icdRate                           per-device intercom rate (legacy: window.P1AdcIcdRate)

// Commercial and Commercial Plus base packages. Several features are offered only on
// these, and the legacy silently unchecks them when the base changes away — see
// :4334-4360. That reset belongs in the component; this constant is exported so both
// sides agree on what "commercial" means rather than repeating the magic numbers.
export const COMMERCIAL_BASE_COSTS = [11.5, 13.95];

export const isCommercialBase = (baseCost) =>
  COMMERCIAL_BASE_COSTS.some((c) => Math.abs(c - Number(baseCost || 0)) < 0.005);

// Commercial Video and Commercial Video Plus are the only tiers offering the
// intercom add-on — :4396, which tests the video rate rather than a name.
const CV_INTERCOM_VIDEO_RATES = [1.5, 3.1];

export const hasCvIntercom = (videoValue) =>
  CV_INTERCOM_VIDEO_RATES.some((r) => Math.abs(r - Number(videoValue || 0)) < 0.005);

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const int = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
};

// Which configured package the selected base cost corresponds to. Matched on COST,
// not on a stored id — :4459 does the same, because the base dropdown's value is the
// dollar amount. Supervision and Noonlight prices then vary per package.
function packageIdForBase(adcCfg, baseCost) {
  const packages = (adcCfg && adcCfg.packages) || [];
  const hit = packages.find((p) => Math.abs(num(p.cost) - num(baseCost)) < 0.005);
  return hit ? hit.id : null;
}

// :4460 — a per-package table with a 'default' fallback.
function pickForPackage(table, packageId) {
  if (!table) return 0;
  if (packageId && Object.prototype.hasOwnProperty.call(table, packageId)) {
    return num(table[packageId]);
  }
  return num(table.default);
}

/**
 * What one add-on costs on a given package — a transcription of legacy `priceFor`
 * (:15741-15745).
 *
 * Returns a number, or NULL meaning "not offered on this package at all". The
 * distinction is load-bearing and is not the same as zero:
 *
 *   null   the add-on does not exist for this package. The legacy HIDES the checkbox
 *          and FORCE-UNCHECKS it (:15760-15763), so switching package can remove a
 *          selection the estimator already made.
 *   0      offered and included — the legacy labels it "(included)" (:15769).
 *   > 0    offered at that price.
 *
 * 22 of the 24 add-ons in the real rate config price differently per package: lights,
 * locks, shades and thermostats are $1.25 on a default package and $0 on Gold,
 * Automation and Commercial Plus, where they are bundled. A single price per add-on
 * cannot express that, and using one overcharges every bundled package.
 */
export function addonPrice(adcCfg, addonId, packageId) {
  const list = (adcCfg && adcCfg.addOns) || [];
  const addon = list.find((a) => a && a.id === addonId);
  if (!addon) return null;
  const prices = addon.prices || {};
  // hasOwnProperty, not a truthiness check: a package key holding 0 means "included"
  // and must win over the default, while `prices[pkgId] || prices.default` would
  // silently fall through to the default and charge for something bundled.
  if (packageId && Object.prototype.hasOwnProperty.call(prices, packageId)) {
    const v = prices[packageId];
    return v === null || v === undefined ? null : num(v);
  }
  if (Object.prototype.hasOwnProperty.call(prices, 'default')) {
    const v = prices.default;
    return v === null || v === undefined ? null : num(v);
  }
  return null;
}

/**
 * Every add-on with its price for the selected base cost, for rendering. `available`
 * false means the legacy would hide it — the caller must also clear any selection,
 * the way :15762 does.
 */
export function addonsForBase(adcCfg, baseCost) {
  const packageId = packageIdForBase(adcCfg, baseCost);
  return ((adcCfg && adcCfg.addOns) || []).map((a) => {
    const price = addonPrice(adcCfg, a.id, packageId);
    return { id: a.id, price: price === null ? 0 : price, available: price !== null };
  });
}

/**
 * Video component of the monthly total — :4380-4394.
 *
 * Three mutually exclusive modes, decided by the selected option's data-type:
 *   flat       a fixed monthly figure (doorbells, and the "none" case)
 *   expansion  Pro Video with Analytics: a base plus expansions, servers, intercom
 *   perCamera  anything else with a rate: the rate times the camera count
 */
export function computeVideo(video = {}, rates = {}) {
  const value = num(video.value);
  const type = video.type || '';
  const isFlat = type === 'flat' || value === 0;
  const isExpansion = type === 'expansion';
  const isPerCamera = value > 0 && !isFlat && !isExpansion;

  if (isExpansion) {
    // :4390 — an option carrying data-vid supplies its own base; otherwise the
    // configured expansion base applies.
    const base = video.hasOwnBase ? value : num(rates.videoExpansionBase);
    return (
      base +
      num(video.expansions) +
      int(video.servers) * num(rates.videoSvr) +
      num(video.intercom)
    );
  }
  if (isPerCamera) {
    // :4384 — at least one camera, matching the legacy's Math.max(1, …).
    return value * Math.max(1, int(video.cameras) || 1);
  }
  return value;
}

/**
 * Commercial Video intercom — :4399-4401.
 * Devices bill per unit; users bill per started block of five.
 */
export function computeCvIntercom(cv = {}, rates = {}) {
  const perDevice = rates.icdRate != null ? num(rates.icdRate) : 1.25;
  const devices = int(cv.devices) * perDevice;
  const users = Math.ceil(int(cv.users) / 5) * 1.25;
  return devices + users;
}

/**
 * Smarter Access Control — :4196-4254 and :4405-4412.
 *
 * With the section enabled the price is assembled from its parts; with it disabled
 * the package dropdown's own value stands alone. Additional doors are priced at the
 * package's per-door rate, up to 32.
 */
export function computeAccess(access = {}, rates = {}) {
  if (!access.enabled) return num(access.packageValue);
  return (
    num(access.bundle) +
    num(access.doors) +
    num(access.mobile10) +
    num(access.mobile100)
  );
}

/** The per-door monthly rate for a package — :4215. */
export const doorRateFor = (pkg, rates = {}) =>
  pkg === 'sacp' ? num(rates.doorRateSACP) : num(rates.doorRateStd);

/**
 * Door options the dropdown offers — :4227-4233. 1 to 32 doors, each priced at the
 * package rate. Generated rather than stored so the list cannot drift from the rate.
 */
export function doorOptions(pkg, rates = {}) {
  const rate = doorRateFor(pkg, rates);
  const options = [{ value: 0, label: '0 Doors ($0.00)' }];
  for (let i = 1; i <= 32; i++) {
    const cost = Number((i * rate).toFixed(2));
    options.push({ value: cost, label: `${i} Door${i > 1 ? 's' : ''} ($${cost.toFixed(2)})` });
  }
  return options;
}

/**
 * The whole Alarm.com monthly figure — :4322-4485.
 *
 * Returns the total AND its parts. The legacy only ever produced the total, writing
 * it into a hidden field; the breakdown is what lets a customer proposal show why a
 * number is what it is, and what makes a parity mismatch diagnosable rather than
 * just "the totals differ".
 */
export function computeAdc(input = {}, rates = {}) {
  const adcCfg = rates.adc || null;
  const base = num(input.base);
  const parts = {};

  parts.base = base;

  parts.video = computeVideo(input.video, rates);

  // Only Commercial Video tiers offer it; the legacy zeroes the fields when the tier
  // changes away (:4397-4398), so an unrelated tier cannot carry a stale charge.
  parts.cvIntercom = hasCvIntercom(input.video && input.video.value)
    ? computeCvIntercom(input.cvIntercom, rates)
    : 0;

  parts.access = computeAccess(input.access, rates);

  // Checked add-ons — :4416, priced through the package matrix at :15741.
  //
  // THESE ARE IDS, NOT AMOUNTS. The legacy writes each package's price onto the
  // checkbox's own value and then sums those values, so the dollars are decided by
  // whatever `reprice` last wrote. Passing ids here and resolving them against the
  // selected package makes that impossible to get wrong from the outside — the panel
  // cannot hand this function a stale or package-mismatched amount, because it no
  // longer hands it amounts at all.
  //
  // Numbers are still accepted so an older caller degrades to the previous behaviour
  // rather than silently summing NaN.
  const packageIdForAddons = packageIdForBase(adcCfg, base);
  parts.addons = (input.addons || []).reduce((sum, entry) => {
    if (typeof entry === 'number') return sum + num(entry);
    const price = addonPrice(adcCfg, entry, packageIdForAddons);
    // null means the package does not offer it: contributes nothing, matching the
    // legacy, which hides and unchecks it (:15760-15763).
    return sum + (price === null ? 0 : price);
  }, 0);

  parts.sensors = num(input.sensors);
  parts.aid = num(input.aid);
  parts.cars = num(input.cars) + num(input.fleet);      // :4444-4445
  parts.comms = num(input.comms);

  // Phase 2 quantity tiers — :4448-4451. Each dropdown's value is already a dollar
  // amount, built from config.
  parts.tiers =
    num(input.flexIo) +
    num(input.cellConnector) +
    num(input.verizonData) +
    num(input.imageEvents);

  // Supervision and Noonlight store a package-INDEPENDENT selection (a level name, a
  // licence count) rather than a price, so an imported estimate restores correctly
  // whatever order the fields load in. Their dollars are resolved here against the
  // package actually selected — :4453-4472.
  const packageId = packageIdForBase(adcCfg, base);

  parts.supervision = 0;
  if (adcCfg && input.supervision) {
    const sup = adcCfg.supervision || {};
    if (input.supervision === 'six') parts.supervision = pickForPackage(sup.sixHour, packageId);
    else if (input.supervision === 'hourly') parts.supervision = pickForPackage(sup.hourly, packageId);
  }

  // Noonlight — :4467-4471. Some packages include free licences; only the excess
  // bills.
  parts.noonlight = 0;
  if (adcCfg) {
    const nl = (adcCfg.tiers || {}).noonlightLicenses;
    if (nl) {
      const qty = int(input.noonlightLicenses);
      const free =
        nl.freeUnits && packageId && Object.prototype.hasOwnProperty.call(nl.freeUnits, packageId)
          ? int(nl.freeUnits[packageId])
          : 0;
      parts.noonlight = Math.max(0, qty - free) * (num(nl.perUnit) || 2);
    }
  }

  // LiftMaster — :4475-4478. Applied automatically whenever the integration is
  // checked, mirroring the portal. Not a separate control the estimator can forget.
  parts.liftmaster =
    input.liftmasterIntegration && adcCfg && adcCfg.liftmasterSurcharge != null
      ? num(adcCfg.liftmasterSurcharge)
      : 0;

  const total = Object.values(parts).reduce((sum, v) => sum + v, 0);

  return { total, parts, packageId };
}
