// Rental equipment — an untaxed one-time job cost that marks up like a subcontractor.
//
// Ported from legacy/index.html, added to `main` on 14 Sep 2026 (af1427c):
// rentalUnitOptions/addRentalRow (:5802-5890), rentalMarkupVal (:5892-5897),
// syncRentalRows (:5899-5924), getRentalRows (:5926-5942), and the roll-up into
// calc() at :4690-4693, :4700, :4894-4895 and :4902-4904.
//
// WHAT IT IS, in the estimator's words: a lift or piece of equipment hired to do the
// install. The vendor's charge is entered tax-included, marked up, and billed on as a
// one-time line. It is not recurring and never touches RMR.
//
// THREE THINGS A CARELESS PORT GETS WRONG, all of which produce a plausible number:
//
//   1. The unit (Day/Week/Month/Each) is a LABEL, not a divisor. src/lib/materials.js
//      sits one file away and its `unit` divides by 100 or 1,000 — reusing
//      unitDivisor here would quietly price a week-long lift hire at 1/100th.
//      Pinned by a parity case.
//
//   2. Rental is UNTAXED. Material sales tax applies to materials only (:4694-4696);
//      folding rental into the tax base overcharges every taxable job.
//
//   3. The markup is its OWN slider, defaulting to 15% over a 0-50% range — not the
//      T&M subcontract markup (42%) and not the material markup (69%). Three
//      different numbers live within a few lines of each other in the legacy.
//
// Like the T&M subcontract before it, this is billed = cost x (1 + markup) — a markup,
// not a gross margin. Here the legacy at least names it honestly.

const num = (v, fallback = 0) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

/** The units the legacy offers — :5802-5806. Descriptive only; see note 1 above. */
export const RENTAL_UNITS = ['Day', 'Week', 'Month', 'Each'];

/** The legacy's slider bounds and default — :2567 and :5892-5897. */
export const RENTAL_MARKUP_DEFAULT = 0.15;
export const RENTAL_MARKUP_MAX = 0.5;

/**
 * Price a set of rental rows — :5899-5924.
 *
 * rows: [{ desc, vendor, part, qty, unit, cost }]
 * opts: { rentalMarkup (fraction), delivery (pickup / drop-off charge) }
 *
 * THE TOTAL IS DERIVED THE LEGACY'S WAY: (equipment + delivery) x (1 + markup),
 * not by summing the per-line billed amounts. The two are algebraically identical and
 * a parity case asserts they agree to the cent — but summing floats in a different
 * order is exactly how a total lands a penny away from its own lines, and the
 * customer's copy shows both.
 *
 * The pickup / drop-off charge is marked up like the equipment (:5915-5916). It is a
 * vendor charge, not a Point 1 delivery fee.
 */
export function computeRentalTotals(rows = [], opts = {}) {
  const markup = num(opts.rentalMarkup, RENTAL_MARKUP_DEFAULT);

  let equipmentCost = 0;
  const lines = [];
  for (const row of rows) {
    const qty = num(row.qty);
    const cost = num(row.cost);
    const extended = qty * cost;          // :5908 — qty x unit cost, no divisor
    equipmentCost += extended;
    lines.push({
      desc: String(row.desc ?? ''),
      vendor: String(row.vendor ?? ''),
      part: String(row.part ?? ''),
      qty,
      unit: row.unit || 'Day',
      cost,
      extended,
      billed: extended * (1 + markup),    // :5911
    });
  }

  const delivery = num(opts.delivery);
  const cost = equipmentCost + delivery;  // :5915
  const billed = cost * (1 + markup);     // :5916

  return {
    lines,
    equipmentCost,
    delivery,
    deliveryBilled: delivery * (1 + markup),
    cost,
    billed,
    gp: billed - cost,
    markup,
  };
}

/**
 * The lines that reach a customer's proposal and the copy summary — getRentalRows
 * at :5926-5942, which keeps a row only `if (desc || cost > 0)`.
 *
 * A half-typed row is still priced (it contributes zero) but must not print as a
 * blank line item, so the filter is on OUTPUT rather than on pricing. Money is
 * unaffected either way — an excluded row is worth nothing — which is why the
 * distinction is safe to make here instead of in computeRentalTotals.
 */
export const printableRentalLines = (totals) =>
  (totals?.lines || []).filter((l) => l.desc !== '' || l.cost > 0);

/** Does this quote carry rental at all? — the legacy's section gate at :4742. */
export const hasRental = (totals) => !!totals && (totals.cost > 0 || totals.billed > 0);
