// The empty shape of everything a quote holds.
//
// WHY THESE LEFT THEIR COMPONENTS. Each factory used to sit beside the component that
// renders it, which reads well until something that is not a component needs one:
// estimateFile.js builds a blank estimate to fill from a .p1est, and importing
// AdcPanel.jsx to get an empty object drags React and six .jsx files in with it. That
// put the .p1est importer — the thing that decides whether months of saved estimates
// open correctly — out of reach of a Node harness, and this repo has learned twice
// what untested pricing code does.
//
// So the shapes live here, in plain JavaScript, and the components re-export them so
// existing imports keep working. Nothing here renders and nothing here does
// arithmetic.

let seq = 1;
const key = (p) => `${p}${seq++}`;

/** Alarm.com — AdcPanel.jsx renders it, src/lib/adc.js prices it. */
export const newAdcState = () => ({
  base: '',
  sections: {},                    // toggle name → open
  video: { value: '', type: '', cameras: 1, expansions: '', servers: 0, intercom: '' },
  videoScope: {},
  cvIntercom: { devices: 0, users: 0 },
  access: { enabled: false, packageValue: '', package: '', bundle: '', doors: '', mobile10: '', mobile100: '' },
  addons: {},
  sensors: '', aid: '', cars: '', fleet: '', comms: '',
  flexIo: '', cellConnector: '', verizonData: '', imageEvents: '',
  supervision: '', noonlightLicenses: 0,
  openEye: false, enterpriseWellness: false, wellness: false,
  scheduledArm: false, esc: false, mlEsc: false, mobileCreds: false,
});

/** Estimate identity, billing address, and the one-time charges. */
export const newEstimateDetails = () => ({
  estimateNumber: '', agreementName: '', estimatorName: '', estimatorEmail: '',
  billing: { same: false, address: '', city: '', state: '', zip: '' },
  shippingCost: '', shippingMarkup: 15, materialTaxRate: '',
});

export const newMaterialRow = (partial = {}) => ({
  key: key('m'), type: 'material',
  desc: '', cost: '', qty: 1, unit: 'ea',
  vendor: '', source: '', partNumber: '', quoteNumber: '', manufacturer: '',
  chargeTo: '',
  laborHrs: '', laborRate: '', laborSellRate: '',
  pkgSize: '', pkgUnit: '', waste: '', costBy: 'actual', manualCost: '',
  ...partial,
});

export const newLaborRow = (partial = {}) => ({
  key: key('l'), type: 'labor',
  desc: '', hrs: '', rate: '', sellPerHr: '', chargeTo: '',
  ...partial,
});

export const newTmSubRow = (partial = {}) => ({
  key: key('t'), desc: '', cost: '', billTo: 'customer', pco: '', ...partial,
});

export const newRentalRow = (partial = {}) => ({
  key: key('r'), desc: '', vendor: '', part: '', qty: 1, unit: 'Day', cost: '', ...partial,
});

export const newRentalState = () => ({ rows: [], delivery: '', markup: 15 });

export const newSubcontractor = () => ({ type: '', description: '', annualCost: '' });
