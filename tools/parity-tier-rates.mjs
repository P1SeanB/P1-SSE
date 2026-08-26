#!/usr/bin/env node
// Do the SLA tier rates match the PUBLISHED rate card?
//
//   npm run parity:tiers
//
// THE GAP THIS CLOSES. parity-sla.mjs proves the budget arithmetic: rate x hours,
// summed, converted by frequency. It takes the rates as given. So it passed for months
// while the rates themselves were computed rather than published — the same
// inputs-versus-arithmetic blind spot that hid the missing adc tree, the add-ons
// resolving against a group that does not exist, and the whole snake_case/PascalCase
// mismatch.
//
// slaRateTable used to derive tiers by multiplying straight time by the priority and
// premier multipliers, transcribed from legacy :8199-8207 — which the legacy assigns
// and never reads. The live path is :9702-9706, which reads the published tierRates.
//
// THE PUBLISHED CARD IS NOT A MULTIPLIER GRID, and that is the whole point:
//
//   emergency is FLAT at 266.03 on every tier — no multiplier does that
//   Priority time-and-a-half (230.67) equals Premier straight time
//
// So this harness asserts the exact published matrix and, separately, asserts that the
// multiplier model would DISAGREE with it. That second assertion is what stops someone
// reintroducing the derivation later and seeing green.
import { slaRateTable } from '../src/lib/calc.js';

// The real Dec 2025 - Nov 2026 card, as exported from the legacy config's tierRates.
// Values are strings because tier_rate is numeric(10,2) and node-postgres returns
// those as strings — if slaRateTable forgets to convert, comparisons break silently.
const TIER_ROWS = [
  { tier_name: 'essential', rate: '177.44', straight_time: '177.44', time_and_half: '219.87', double_time: '266.03' },
  { tier_name: 'priority',  rate: '212.93', straight_time: '212.93', time_and_half: '230.67', double_time: '266.03' },
  { tier_name: 'premier',   rate: '230.67', straight_time: '230.67', time_and_half: '263.84', double_time: '266.03' },
];

// Present, and deliberately WRONG for this purpose. If slaRateTable ever goes back to
// deriving, it will reach for these and the expectations below will fail.
const RATES = {
  tiers: TIER_ROWS,
  serviceCall: {
    StraightTimeRate: 177.44, TimeAndHalfRate: 219.87, DoubleTimeRate: 266.03,
    PriorityMultiplier: 1.2, PremierMultiplier: 1.3,
  },
};

const EXPECTED = {
  essential: { straight: 177.44, timeAndHalf: 219.87, doubleTime: 266.03 },
  priority:  { straight: 212.93, timeAndHalf: 230.67, doubleTime: 266.03 },
  premier:   { straight: 230.67, timeAndHalf: 263.84, doubleTime: 266.03 },
};

const failures = [];
const table = slaRateTable(RATES);

if (!table) {
  failures.push('slaRateTable returned null for a profile that has tier rows');
} else {
  for (const [tier, want] of Object.entries(EXPECTED)) {
    const got = table[tier];
    if (!got) { failures.push(`tier "${tier}" is missing from the table`); continue; }
    for (const [field, expected] of Object.entries(want)) {
      const actual = got[field];
      if (typeof actual !== 'number') {
        failures.push(`${tier}.${field} is ${typeof actual} "${actual}" — numeric strings break comparisons`);
      } else if (Math.abs(actual - expected) > 0.005) {
        failures.push(`${tier}.${field} is ${actual.toFixed(2)}, the published card says ${expected.toFixed(2)}`);
      }
    }
  }
}

// The derivation must NOT reproduce the card. If it ever does, this file has stopped
// testing anything and should be revisited rather than trusted.
const s = RATES.serviceCall;
const derived = {
  priority: { timeAndHalf: s.TimeAndHalfRate * s.PriorityMultiplier, doubleTime: s.DoubleTimeRate * s.PriorityMultiplier },
  premier:  { timeAndHalf: s.TimeAndHalfRate * s.PremierMultiplier,  doubleTime: s.DoubleTimeRate * s.PremierMultiplier },
};
let divergences = 0;
for (const tier of ['priority', 'premier']) {
  for (const field of ['timeAndHalf', 'doubleTime']) {
    if (Math.abs(derived[tier][field] - EXPECTED[tier][field]) > 0.005) divergences++;
  }
}
if (divergences !== 4) {
  failures.push(
    `the multiplier model now agrees with the published card in ${4 - divergences} of 4 places — ` +
    'this harness can no longer tell the two apart',
  );
}

// No tiers must mean NO table, not a quiet fall back to derivation.
if (slaRateTable({ serviceCall: RATES.serviceCall }) !== null) {
  failures.push('slaRateTable invented a table from serviceCall alone — it must return null instead');
}

console.log('\n  tier rates: 9 published values checked, plus 4 derivation divergences');
if (failures.length) {
  console.log(`\n  ${failures.length} PROBLEM(S):`);
  for (const f of failures) console.log(`    - ${f}`);
  console.log('');
  process.exit(1);
}
console.log('  No drift. SLA tiers price from the published card, not from multipliers.\n');
