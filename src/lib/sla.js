// Service-level agreements — budget, rate and term.
//
// Ported from legacy/index.html slaBudgetCalc (:9285-9307) and slaCalcSLARate
// (:9308-9350), plus the frequency helpers already in src/lib/calc.js.
//
// The SLA rate is derived from an ANNUAL budget and then shown per whatever
// frequency the estimator is thinking in. Everything is kept in annual terms until
// the last step, because dividing early and multiplying back is where rounding
// creeps in on a figure that gets multiplied by a 60-month term.

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * A budget line — :9286-9301.
 *
 * Returns zero unless BOTH a rate and hours are present. A rate typed with no hours
 * yet is an unfinished line, not a zero-hour charge, and the legacy greys the total
 * to say so rather than showing $0.00 as though it were decided.
 */
export const budgetLine = (rate, hours) =>
  num(rate) > 0 && num(hours) > 0 ? num(rate) * num(hours) : 0;

/** Money typed with a currency symbol still parses — :9333 strips non-numerics. */
export const parseMoney = (v) =>
  typeof v === 'string' ? num(v.replace(/[^0-9.]/g, '')) : num(v);

/**
 * The annual budget behind an SLA — :9302-9336.
 *
 * ⚠ PM VISITS ALWAYS BILL AT THE STANDARD STRAIGHT RATE, whatever tier the
 * agreement is on (:9318). Priority and Premier multipliers apply to reactive
 * service calls, NOT to scheduled maintenance. Applying the tier multiplier here
 * overcharges every Priority and Premier agreement, and it looks entirely
 * reasonable while doing it.
 */
export function slaAnnualBudget(input = {}, rates = {}) {
  const regular = budgetLine(input.regularRate, input.regularHours);
  const afterHours = budgetLine(input.afterHoursRate, input.afterHoursHours);
  const emergency = budgetLine(input.emergencyRate, input.emergencyHours);

  const pmRate = num(rates.misc?.pmVisitRate ?? rates.pmVisitRate);
  const visits = Math.max(1, parseInt(input.pmVisits, 10) || 1);
  const pm = num(input.pmHours) * visits * pmRate;

  const materials = parseMoney(input.materialsAmount);
  const callouts = num(input.calloutTotal);

  return {
    regular, afterHours, emergency, pm, materials, callouts,
    annual: regular + afterHours + emergency + pm + materials + callouts,
  };
}

/**
 * The SLA rate, in the frequency the estimator is working in — :9338-9346.
 * Monthly is the canonical figure; the others are presentations of it.
 */
export function slaRate(input = {}, rates = {}) {
  const budget = slaAnnualBudget(input, rates);
  const monthly = budget.annual / 12;
  const freq = input.frequency || 'monthly';
  const display = freq === 'quarterly' ? monthly * 3 : freq === 'annual' ? monthly * 12 : monthly;
  return { ...budget, monthly, frequency: freq, display };
}

/**
 * Agreement end date — the legacy's slaCalcEndDate (:3402 binding).
 *
 * The end date is the day BEFORE the anniversary: a 12-month term starting 1 Jan
 * 2026 ends 31 Dec 2026, not 1 Jan 2027. Off by one here is a day of uncovered
 * service, and it appears on a signed document.
 *
 * Uses UTC arithmetic on a plain calendar date so a DST boundary inside the term
 * cannot shift it.
 */
export function slaEndDate(startISO, months) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startISO || ''))) return '';
  const m = parseInt(months, 10);
  if (!Number.isFinite(m) || m <= 0) return '';

  const [y, mo, d] = startISO.split('-').map(Number);
  const end = new Date(Date.UTC(y, mo - 1 + m, d));
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

/** Term presets, plus the custom entry the legacy exposes via sla-custom-months. */
export const TERM_OPTIONS = [
  { value: 12, label: '12 months' },
  { value: 24, label: '24 months' },
  { value: 36, label: '36 months' },
  { value: 60, label: '60 months' },
  { value: 'custom', label: 'Custom…' },
];

export const BILLING_CYCLES = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'annual', label: 'Annual' },
];

/**
 * Response-time commitments per severity. Descriptive, not priced — they are the
 * promise the document makes, and they print on it.
 */
export const RESPONSE_TIERS = [
  { key: 'reg', label: 'Regular' },
  { key: 'ah', label: 'After hours' },
  { key: 'em', label: 'Emergency' },
];
