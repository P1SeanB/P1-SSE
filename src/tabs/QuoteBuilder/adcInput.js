// Panel state -> computeAdc input.
//
// Plain JavaScript, in its own file, because both callers need it and one of them is
// a hook: useMonthlyCosts computes the quote's Alarm.com figure and AdcPanel displays
// it, and if those two ever convert differently the panel shows one number while the
// quote charges another.

/**
 * Panel state -> computeAdc input. EXPORTED, because the quote total needs the same
 * conversion and there must only be one of it.
 *
 * The panel used to build this object inline under a comment claiming it was "the
 * same call the quote total makes". Nothing else called computeAdc at the time, so
 * the claim cost nothing; the moment QuoteBuilder started pricing Alarm.com it passed
 * the panel's raw state instead and `addons` — an object here, a list of ids there —
 * took the whole app down on load. A shape mismatch between two callers of the same
 * function is the mildest possible version of that bug. The next one prices.
 *
 * ADD-ONS GO ACROSS AS IDS, NOT AMOUNTS. 22 of the 24 are priced PER PACKAGE, free on
 * the packages that bundle them and chargeable on the ones that do not, so only
 * computeAdc — which knows the selected package — can turn one into money. An earlier
 * version sent one flat price each, looked up from a pricing_option group named
 * 'adc-addons' that does not exist in the rate data at all: every add-on contributed
 * exactly nothing.
 */
export function adcInputFrom(adc = {}) {
  const addons = adc.addons || {};
  return {
    base: adc.base,
    video: adc.video,
    cvIntercom: adc.cvIntercom,
    access: adc.access,
    addons: Object.entries(addons).filter(([, on]) => on).map(([k]) => k),
    sensors: adc.sensors, aid: adc.aid, cars: adc.cars, fleet: adc.fleet, comms: adc.comms,
    flexIo: adc.flexIo, cellConnector: adc.cellConnector,
    verizonData: adc.verizonData, imageEvents: adc.imageEvents,
    supervision: adc.supervision,
    noonlightLicenses: adc.noonlightLicenses,
    liftmasterIntegration: !!addons['liftmaster-integration'],
  };
}
