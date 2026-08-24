import React from 'react';
import { Card, Field, TextInput, NumInput, Slider, SectionLabel } from '../../components/ui.jsx';
import { computeTmSubTotals } from '../../lib/materials.js';
import { money } from '../../lib/format.js';

// Subcontracted T&M lines — the legacy's tm-sub-rows (index.html:5591 addTMSubRow,
// :5635 syncTMSubRows).
//
// Totals come from computeTmSubTotals, covered by npm run parity:materials.
//
// ⚠ THE SLIDER IS NAMED GM AND APPLIED AS A MARKUP. billed = cost x (1 + rate), not
// cost / (1 - rate) — see :5644. At the default 42% those differ by 21% of the price,
// so the label below says "markup" and shows the resulting multiplier rather than
// repeating the legacy's misleading name. Changing the arithmetic to match the old
// name would reprice every subcontracted job.

const BILL_TO = [
  { value: 'customer', label: 'Bill to customer' },
  { value: 'internal', label: 'Absorb internally' },
];

let seq = 1;
export const newTmSubRow = (partial = {}) => ({
  key: `t${seq++}`, desc: '', cost: '', billTo: 'customer', pco: '', ...partial,
});

export default function TmSubRows({ rows, onRowsChange, tmSubGM, onGmChange }) {
  const totals = computeTmSubTotals(rows, { tmSubGM });
  const update = (key, patch) => onRowsChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const remove = (key) => onRowsChange(rows.filter((r) => r.key !== key));

  return (
    <Card title="T&amp;M Subcontract">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
        <Slider label={`Subcontract markup — billed at ${(1 + tmSubGM).toFixed(2)}× cost`}
          value={Math.round(tmSubGM * 100)} min={0} max={100} step={1}
          onChange={(v) => onGmChange(v / 100)} format={(v) => `${v}%`} />

        {rows.length === 0 && (
          <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-muted, #6b7688)' }}>
            No subcontracted lines. Add one for work another trade is performing.
          </p>
        )}

        {rows.map((row, i) => {
          const line = totals.lines[i] || {};
          return (
            <div key={row.key} style={{
              display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr auto', gap: '0.5rem',
              alignItems: 'end', border: '1px solid var(--border, #d8dbe0)', borderRadius: 8, padding: '0.6rem',
            }}>
              <Field label="Description">
                <TextInput value={row.desc} onChange={(v) => update(row.key, { desc: v })} />
              </Field>
              <Field label="Cost">
                <NumInput value={row.cost} onChange={(v) => update(row.key, { cost: v })} step="0.01" />
              </Field>
              {/* Added Aug 2026: a subcontracted line is either billed on or absorbed,
                  and a PCO number ties it to the change it came from. */}
              <Field label="Billing">
                <select value={row.billTo} onChange={(e) => update(row.key, { billTo: e.target.value })}>
                  {BILL_TO.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                </select>
              </Field>
              <Field label="PCO #">
                <TextInput value={row.pco} onChange={(v) => update(row.key, { pco: v })} />
              </Field>
              <button type="button" onClick={() => remove(row.key)}
                aria-label={`Remove ${row.desc || 'subcontract line'}`}>Remove</button>
              <div style={{ gridColumn: '1 / -1', fontSize: '0.85rem' }}>
                Cost {money(line.cost)} · billed {money(line.billed)}
              </div>
            </div>
          );
        })}

        <div>
          <button type="button" onClick={() => onRowsChange([...rows, newTmSubRow()])}>
            Add subcontract line
          </button>
        </div>

        {totals.cost > 0 && (
          <div>
            <SectionLabel>Totals</SectionLabel>
            <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.9rem' }}>
              <span>Cost <strong>{money(totals.cost)}</strong></span>
              <span>Billed <strong>{money(totals.billed)}</strong></span>
              <span>GP <strong>{money(totals.gp)}</strong></span>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
