import { useMemo, useState } from 'react';
import {
  priceRows, computeTmSubTotals, computeOneTimeTotal, computeOneTimeMargin,
} from '../../lib/materials.js';
import { computeRentalTotals } from '../../lib/rental.js';
import { newRentalState } from './estimateState.js';

// The one-time side of a quote: materials, installation labour, subcontracted lines
// and rental equipment, plus the two roll-ups they feed.
//
// WHY A HOOK RATHER THAN STATE IN QuoteBuilder. Three consumers need these numbers —
// the editor cards, the margin panel on the right, and the .p1est file — and
// QuoteBuilder is already long enough that adding five more useState calls and four
// more useMemos to it is how the monolith comes back. Everything one-time lives here,
// and the tab reads it.
//
// PERCENTAGES IN, FRACTIONS OUT. Every slider and input in this app carries a whole
// number (69, 42, 8.25) because that is what an estimator types; every function in
// src/lib takes a fraction. The conversion happens HERE, once, rather than at each
// call site — the legacy does it at each call site and gets it right, and a port that
// misses one produces a markup of 4,200%.

/** Defaults come from the rate profile, not from constants — legacy :3424-3432. */
const pctOf = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n / 100 : fallback;
};

export function useOneTimeWork(rates) {
  // Material and installation-labour lines share one list: a material row can carry
  // attached labour hours, and priceRows emits that as a second item. Splitting the
  // list would mean reconciling the two halves on every edit.
  const [rows, setRows] = useState([]);
  const [tmSubRows, setTmSubRows] = useState([]);
  const [rental, setRental] = useState(newRentalState);

  // null means "follow the rate profile"; a number means the estimator moved it.
  const [matMarkup, setMatMarkup] = useState(null);
  const [tmSubGM, setTmSubGM] = useState(null);

  const matMarkupV = matMarkup ?? pctOf(rates?.labor?.MatMarkup, 0.69);
  const tmSubGMV = tmSubGM ?? pctOf(rates?.labor?.TmSubGM, 0.42);

  const priced = useMemo(() => priceRows(rows, {
    matMarkup: matMarkupV,
    laborCostPerHr: rates?.labor?.LaborCostPerHr,
    laborSellDefault: rates?.labor?.LaborSellDefault,
  }), [rows, matMarkupV, rates]);

  const tmSub = useMemo(() => computeTmSubTotals(tmSubRows, { tmSubGM: tmSubGMV }),
    [tmSubRows, tmSubGMV]);

  const rentalTotals = useMemo(() => computeRentalTotals(rental.rows, {
    rentalMarkup: rental.markup / 100,
    delivery: rental.delivery,
  }), [rental]);

  /**
   * The customer's one-time total and the estimator's one-time margin.
   *
   * `charges` carries the fields that live on the Estimate Details card — material
   * sales tax and shipping — because they belong to the same total but not to the
   * same editor. Both arrive as PERCENTAGES.
   */
  const totals = (charges = {}) => {
    const opts = {
      matTaxRate: (Number(charges.materialTaxRate) || 0) / 100,
      shippingCost: charges.shippingCost,
      shippingMarkup: (Number(charges.shippingMarkup) || 0) / 100,
      rental: rentalTotals,
    };
    return computeOneTimeTotal(priced, tmSub, opts);
  };

  /**
   * Cost, gross profit, overhead and net — :4894-4912. Tax and shipping are absent
   * on purpose: neither is Point 1's margin to make, so neither belongs in a margin.
   */
  const margin = (overheadRate, ohMethod) =>
    computeOneTimeMargin(priced, tmSub, { rental: rentalTotals, overheadRate, ohMethod });

  const clear = () => {
    setRows([]);
    setTmSubRows([]);
    setRental(newRentalState());
    setMatMarkup(null);
    setTmSubGM(null);
  };

  return {
    // state + setters, in the shape OneTimeWork renders and the .p1est file stores
    rows, setRows,
    tmSubRows, setTmSubRows,
    rental, setRental,
    matMarkup: matMarkupV, setMatMarkup,
    tmSubGM: tmSubGMV, setTmSubGM,
    // derived
    priced, tmSub, rentalTotals,
    totals, margin,
    hasAny: priced.length > 0 || tmSub.cost > 0 || rentalTotals.cost > 0,
    clear,
  };
}
