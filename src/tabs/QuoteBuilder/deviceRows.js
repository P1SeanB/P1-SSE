// Device-row definitions for the inspection calculators, extracted from the
// repeated markup in legacy/index.html (:1885-1893 fire, :1960-1981 PM).
// `semi: true` = device is re-inspected at the semi-annual visit (fire calc).
// `defaultHrs` mirrors the legacy default input values.

export const FIRE_DEVICES = [
  { key: 'panels',     label: 'Fire panels',            semi: false, defaultHrs: 4 },
  { key: 'pull',       label: 'Pull stations',          semi: false, defaultHrs: 0 },
  { key: 'smokes',     label: 'Smokes / heats',         semi: true,  defaultHrs: 0 },
  { key: 'waterflows', label: 'Waterflows',             semi: true,  defaultHrs: 0 },
  { key: 'tamper',     label: 'Tamper switches',        semi: true,  defaultHrs: 0 },
  { key: 'duct',       label: 'Duct detectors / dampers', semi: false, defaultHrs: 0 },
  { key: 'notify',     label: 'Notification devices',   semi: true,  defaultHrs: 0 },
  { key: 'power',      label: 'Power supplies',         semi: true,  defaultHrs: 0 },
  { key: 'floors',     label: 'Floors',                 semi: false, defaultHrs: 0 },
];

export const PM_STANDARD_DEVICES = [
  { key: 'panels',   label: 'Control panels' },
  { key: 'keypads',  label: 'Keypads' },
  { key: 'motions',  label: 'Motion detectors' },
  { key: 'contacts', label: 'Door / window contacts' },
  { key: 'glass',    label: 'Glass break sensors' },
  { key: 'sirens',   label: 'Sirens / sounders' },
  { key: 'readers',  label: 'Card readers' },
  { key: 'doors',    label: 'Door controllers / locks' },
  { key: 'cameras',  label: 'Cameras / NVR' },
  { key: 'rex',      label: 'REX sensors' },
  { key: 'power',    label: 'Power supplies' },
];

export const PM_AV_DEVICES = [
  { key: 'displays',   label: 'Displays' },
  { key: 'ctrlsys',    label: 'Control System' },
  { key: 'audio',      label: 'Audio System Components' },
  { key: 'videodist',  label: 'Video Distribution Devices' },
  { key: 'rack',       label: 'Rack & Headend Equipment' },
  { key: 'network',    label: 'Network / AV Infrastructure Devices' },
  { key: 'cabling',    label: 'Cabling Endpoints' },
  { key: 'software',   label: 'Software / Firmware Updates' },
  { key: 'complexity', label: 'System Complexity Labor' },
];

// Estimate types — legacy est-type dropdown (built in JS, :9376-9382)
export const ESTIMATE_TYPES = [
  'Fire Monitoring & Services',
  'Burglar Monitoring & Services',
  'Two-Way Monitoring & Services',
  'A/V PM Services',
  'Other/All Services',
  'Time & Material Only',
  'Material Only',
  'Budget Estimate',
  'Flat Rate Estimate',
];

export function blankDeviceState(devices, withFreq) {
  const out = {};
  for (const d of devices) {
    out[d.key] = { hrs: d.defaultHrs ?? 0, mins: 0, count: '', ...(withFreq ? { freq: 1 } : {}) };
  }
  return out;
}
