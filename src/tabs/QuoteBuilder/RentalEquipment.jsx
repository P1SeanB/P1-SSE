import React from 'react';
import { Card, Field, TextInput, NumInput, Slider, SectionLabel } from '../../components/ui.jsx';
import { computeRentalTotals, printableRentalLines, RENTAL_UNITS } from '../../lib/rental.js';
import { money } from '../../lib/format.js';

// Rental equipment — the legacy's rental-wrap panel and section-rental summary
// (legacy/index.html:2320-2349, :2559-2585, rows built by addRentalRow at :5807).
//
// Added to the legacy on 14 Sep 2026. A lift or piece of equipment hired to do the
// install: the vendor's charge goes in tax-included, gets marked up, and bills on as
// a one-time line. It never touches RMR.
//
// All arithmetic is in src/lib/rental.js and covered by npm run parity:rental. This
// component collects rows and displays what that returns.
//
// THE MARKUP SLIDER IS ITS OWN. 15% by default over a 0-50% range — not the 42% T&M
// subcontract markup and not the 69% material markup, both of which are sliders that
// look exactly like this one a few cards away.
//
// THE UNIT IS A LABEL. Day/Week/Month/Each describes what the vendor is charging for
// and is carried onto the proposal; it does not divide the quantity. Materials next
// door work the other way, where '100ft' does divide — see rental.js.

let seq = 1;
export const newRentalRow = (partial = {}) => ({
  key: `r${seq++}`, desc: '', vendor: '', part: '', qty: 1, unit: 'Day', cost: '', ...partial,
});

export const newRentalState = () => ({ rows: [], delivery: '', markup: 15 });

export default function RentalEquipment({ value, onChange }) {
  const { rows, delivery, markup } = value;
  const set = (patch) => onChange({ ...value, ...patch });
  const update = (key, patch) => set({ rows: rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) });
  const remove = (key) => set({ rows: rows.filter((r) => r.key !== key) });

  const totals = computeRentalTotals(rows, { rentalMarkup: markup / 100, delivery });
  const printable = printableRentalLines(totals);

  return (
    <Card title="Rental Equipment">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
        <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-muted, #6b7688)' }}>
          Untaxed job cost — equipment hired to do the install. Enter the vendor&apos;s charge with
          tax included; it marks up like a subcontractor and rolls into the one-time total.
        </p>

        <Slider label={`Rental markup — billed at ${(1 + markup / 100).toFixed(2)}× cost`}
          value={markup} min={0} max={50} step={1}
          onChange={(v) => set({ markup: v })} format={(v) => `${v}%`} />

        {rows.length === 0 && (
          <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-muted, #6b7688)' }}>
            No rental lines. Add one for a lift or other equipment hired for this job.
          </p>
        )}

        {rows.map((row, i) => {
          const line = totals.lines[i] || {};
          return (
            <div key={row.key} style={{
              display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 0.6fr 0.8fr 1fr auto', gap: '0.5rem',
              alignItems: 'end', border: '1px solid var(--border, #d8dbe0)', borderRadius: 8, padding: '0.6rem',
            }}>
              <Field label="Equipment">
                <TextInput value={row.desc} onChange={(v) => update(row.key, { desc: v })}
                  placeholder="e.g. 26ft scissor lift" />
              </Field>
              <Field label="Vendor">
                <TextInput value={row.vendor} onChange={(v) => update(row.key, { vendor: v })} />
              </Field>
              <Field label="Part / Quote #">
                <TextInput value={row.part} onChange={(v) => update(row.key, { part: v })} />
              </Field>
              <Field label="Qty">
                <NumInput value={row.qty} onChange={(v) => update(row.key, { qty: v })} step="1" min="0" />
              </Field>
              <Field label="Per">
                <select value={row.unit} onChange={(e) => update(row.key, { unit: e.target.value })}>
                  {RENTAL_UNITS.map((u) => <option key={u}>{u}</option>)}
                </select>
              </Field>
              <Field label="Unit cost">
                <NumInput value={row.cost} onChange={(v) => update(row.key, { cost: v })} step="0.01" min="0" />
              </Field>
              <button type="button" onClick={() => remove(row.key)}
                aria-label={`Remove ${row.desc || 'rental line'}`}>Remove</button>
              <div style={{ gridColumn: '1 / -1', fontSize: '0.85rem' }}>
                Cost {money(line.extended)} · billed {money(line.billed)}
              </div>
            </div>
          );
        })}

        <div>
          <button type="button" onClick={() => set({ rows: [...rows, newRentalRow()] })}>
            Add rental
          </button>
        </div>

        {/* A vendor charge, so it is marked up with the equipment rather than passed
            through at cost — legacy :5915-5916. */}
        <Field label="Pickup / drop-off charge">
          <NumInput value={delivery} onChange={(v) => set({ delivery: v })} step="0.01" min="0" />
        </Field>

        {totals.cost > 0 && (
          <div>
            <SectionLabel>Totals</SectionLabel>
            <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.9rem' }}>
              <span>Rental cost <strong>{money(totals.cost)}</strong></span>
              <span>Billed to customer <strong>{money(totals.billed)}</strong></span>
              <span>GP <strong>{money(totals.gp)}</strong></span>
            </div>
            <p style={{ margin: '0.3rem 0 0', fontSize: '0.8rem', color: 'var(--text-muted, #6b7688)' }}>
              {printable.length} line{printable.length === 1 ? '' : 's'} on the customer&apos;s proposal.
              Rental is not taxed.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
