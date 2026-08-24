import React from 'react';
import { Card, Field, TextInput, NumInput, SectionLabel } from '../../components/ui';
import {
  priceRows, computeMaterialLine, totalMaterialSell, totalMaterialCost,
  materialMargin, laborMargin, unitLabel,
} from '../../lib/materials';

// Material and labour line items — the legacy's mat-rows table (index.html:5714+,
// addMatRow / addPartRow), rebuilt as a controlled list.
//
// EVERY NUMBER SHOWN HERE COMES FROM src/lib/materials.js. Nothing is recomputed
// inline, because a total computed in a component is a total nothing tests — and
// this codebase has already shipped one silent pricing drift that survived because
// the arithmetic lived inside the rendering.
//
// The legacy stored each row's state across a dozen sibling DOM elements keyed by an
// id prefix (mat-3-cost, mat-3-qty, mat-3-lphrs…) and recalculated by reading them
// back. Here a row is an object and the table is a projection of it.

const UNITS = [
  { value: 'ea', label: 'ea' },
  { value: '100ft', label: '100 ft' },
  { value: '1000ft', label: '1,000 ft' },
];

const COST_MODES = [
  { value: 'actual', label: 'Actual usage' },
  { value: 'package', label: 'Full package' },
  { value: 'manual', label: 'Manual job cost' },
];

const money = (n) =>
  (n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

let nextId = 1;
export const newMaterialRow = (partial = {}) => ({
  key: `m${nextId++}`, type: 'material',
  desc: '', cost: '', qty: 1, unit: 'ea',
  vendor: '', source: '', partNumber: '', quoteNumber: '', manufacturer: '',
  chargeTo: '',
  laborHrs: '', laborRate: '', laborSellRate: '',
  pkgSize: '', pkgUnit: '', waste: '', costBy: 'actual', manualCost: '',
  ...partial,
});

export const newLaborRow = (partial = {}) => ({
  key: `l${nextId++}`, type: 'labor',
  desc: '', hrs: '', rate: '', sellPerHr: '', chargeTo: '',
  ...partial,
});

function MaterialRow({ row, opts, onChange, onRemove }) {
  const set = (patch) => onChange({ ...row, ...patch });

  // The same function the totals use, so what a row displays and what the quote
  // charges can never disagree.
  const priced = computeMaterialLine({
    cost: parseFloat(row.cost) || 0,
    qty: parseFloat(row.qty) || 0,
    unit: row.unit,
    matMarkup: opts.matMarkup,
    lpHrs: parseFloat(row.laborHrs) || 0,
    waste: parseFloat(row.waste) || 0,
    pkgSize: parseFloat(row.pkgSize) || 0,
    costBy: row.costBy,
    manualCost: row.manualCost,
  });

  // Only offered when the row is priced by whole packages — the legacy shows and
  // hides this block the same way (:6377).
  const showPackaging = row.costBy === 'package';
  const showManual = row.costBy === 'manual';

  return (
    <div style={{
      border: '1px solid var(--border, #d8dbe0)', borderRadius: 8,
      padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.6rem',
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr auto', gap: '0.5rem', alignItems: 'end' }}>
        <Field label="Description">
          <TextInput value={row.desc} onChange={(v) => set({ desc: v })} placeholder="Material" />
        </Field>
        <Field label={`Cost / ${unitLabel(row.unit)}`}>
          <NumInput value={row.cost} onChange={(v) => set({ cost: v })} step="0.01" min="0" />
        </Field>
        <Field label="Qty">
          <NumInput value={row.qty} onChange={(v) => set({ qty: v })} step="any" min="0" />
        </Field>
        <Field label="Unit">
          <select value={row.unit} onChange={(e) => set({ unit: e.target.value })}>
            {UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
          </select>
        </Field>
        <button type="button" onClick={onRemove} aria-label={`Remove ${row.desc || 'material'}`}>Remove</button>
      </div>

      {/* Purchasing detail — feeds the BOM export. Kept on the row, matching the
          Aug 2026 change that moved part number onto the material row between
          vendor and source. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(8rem,1fr))', gap: '0.5rem' }}>
        <Field label="Vendor"><TextInput value={row.vendor} onChange={(v) => set({ vendor: v })} placeholder="Who we buy from" /></Field>
        <Field label="Part #"><TextInput value={row.partNumber} onChange={(v) => set({ partNumber: v })} /></Field>
        <Field label="Source"><TextInput value={row.source} onChange={(v) => set({ source: v })} /></Field>
        <Field label="Quote #"><TextInput value={row.quoteNumber} onChange={(v) => set({ quoteNumber: v })} /></Field>
        <Field label="Manufacturer"><TextInput value={row.manufacturer} onChange={(v) => set({ manufacturer: v })} /></Field>
        <Field label="Charge to"><TextInput value={row.chargeTo} onChange={(v) => set({ chargeTo: v })} placeholder="SWO / SEQ / phase / PM" /></Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(8rem,1fr))', gap: '0.5rem' }}>
        <Field label="Cost by">
          <select value={row.costBy} onChange={(e) => set({ costBy: e.target.value })}>
            {COST_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Field>
        <Field label="Waste %">
          <NumInput value={row.waste} onChange={(v) => set({ waste: v })} min="0" max="100" step="1" />
        </Field>
        {showPackaging && (
          <>
            <Field label="Package size"><NumInput value={row.pkgSize} onChange={(v) => set({ pkgSize: v })} min="0" step="any" /></Field>
            <Field label="Package unit"><TextInput value={row.pkgUnit} onChange={(v) => set({ pkgUnit: v })} placeholder="reel, box" /></Field>
          </>
        )}
        {showManual && (
          <Field label="Manual job cost">
            <NumInput value={row.manualCost} onChange={(v) => set({ manualCost: v })} min="0" step="0.01" />
          </Field>
        )}
        <Field label="Install hrs"><NumInput value={row.laborHrs} onChange={(v) => set({ laborHrs: v })} min="0" step="any" /></Field>
      </div>

      {/* The legacy falls back to actual costing when a package row is
          under-configured, and says why (:6374-6376). Surfacing that is the
          difference between "the estimator sees the waste was dropped" and
          "the quote is quietly short". */}
      {priced.err && (
        <div role="status" style={{ fontSize: '0.85rem', color: '#9a6414' }}>
          {priced.err} Charged at actual usage for now.
        </div>
      )}

      <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', fontSize: '0.85rem' }}>
        <span>Job cost <strong>{money(priced.jobCost)}</strong></span>
        <span>Sell <strong>{money(priced.totalSell)}</strong></span>
        {priced.packages > 0 && <span>{priced.packages} package{priced.packages > 1 ? 's' : ''}</span>}
        {priced.adjQty !== (parseFloat(row.qty) || 0) && (
          <span>Adjusted qty {priced.adjQty.toFixed(2)}</span>
        )}
        {priced.labHrs > 0 && <span>Install {priced.labHrs.toFixed(2)} hrs</span>}
      </div>
    </div>
  );
}

function LaborRow({ row, onChange, onRemove }) {
  const set = (patch) => onChange({ ...row, ...patch });
  const hrs = parseFloat(row.hrs) || 0;
  const cost = hrs * (parseFloat(row.rate) || 0);
  const sell = hrs * (parseFloat(row.sellPerHr) || 0);

  return (
    <div style={{
      border: '1px solid var(--border, #d8dbe0)', borderRadius: 8, padding: '0.75rem',
      display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr auto', gap: '0.5rem', alignItems: 'end',
    }}>
      <Field label="Description"><TextInput value={row.desc} onChange={(v) => set({ desc: v })} placeholder="Labor" /></Field>
      <Field label="Hours"><NumInput value={row.hrs} onChange={(v) => set({ hrs: v })} min="0" step="any" /></Field>
      <Field label="Cost / hr"><NumInput value={row.rate} onChange={(v) => set({ rate: v })} min="0" step="0.01" /></Field>
      <Field label="Sell / hr"><NumInput value={row.sellPerHr} onChange={(v) => set({ sellPerHr: v })} min="0" step="0.01" /></Field>
      <Field label="Charge to"><TextInput value={row.chargeTo} onChange={(v) => set({ chargeTo: v })} /></Field>
      <button type="button" onClick={onRemove} aria-label={`Remove ${row.desc || 'labor'}`}>Remove</button>
      <div style={{ gridColumn: '1 / -1', display: 'flex', gap: '1.25rem', fontSize: '0.85rem' }}>
        <span>Cost <strong>{money(cost)}</strong></span>
        <span>Sell <strong>{money(sell)}</strong></span>
      </div>
    </div>
  );
}

/**
 * The materials and labour section.
 *
 * `rows` is the single source of truth; totals are derived on every render by the
 * same library the API and the parity harness use. There is no second copy of the
 * arithmetic to fall out of step.
 */
export default function MaterialRows({ rows, onRowsChange, matMarkup = 0.69, rates = {} }) {
  const opts = {
    matMarkup,
    laborCostPerHr: rates.labor?.LaborCostPerHr,
    laborSellDefault: rates.labor?.LaborSellDefault,
  };

  const priced = priceRows(rows, opts);
  const matBilled = totalMaterialSell(priced);
  const matCost = totalMaterialCost(priced);
  const mat = materialMargin(priced);
  const lab = laborMargin(priced);

  const update = (key, next) => onRowsChange(rows.map((r) => (r.key === key ? next : r)));
  const remove = (key) => onRowsChange(rows.filter((r) => r.key !== key));

  return (
    <Card title="Materials &amp; Labor">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {rows.length === 0 && (
          <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-muted, #6b7688)' }}>
            No lines yet. Add a material or a labor line to start pricing this job.
          </p>
        )}

        {rows.map((row) =>
          row.type === 'material' ? (
            <MaterialRow key={row.key} row={row} opts={opts}
              onChange={(next) => update(row.key, next)} onRemove={() => remove(row.key)} />
          ) : (
            <LaborRow key={row.key} row={row}
              onChange={(next) => update(row.key, next)} onRemove={() => remove(row.key)} />
          ),
        )}

        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button type="button" onClick={() => onRowsChange([...rows, newMaterialRow()])}>
            Add material
          </button>
          <button type="button" onClick={() => onRowsChange([...rows, newLaborRow()])}>
            Add labor
          </button>
        </div>

        <SectionLabel>Totals</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(10rem,1fr))', gap: '0.75rem', fontSize: '0.9rem' }}>
          <div>Material cost<br /><strong>{money(matCost)}</strong></div>
          <div>Material sell<br /><strong>{money(matBilled)}</strong></div>
          <div>Material margin<br /><strong>{mat.marginPct == null ? '—' : `${(mat.marginPct * 100).toFixed(1)}%`}</strong></div>
          <div>Labor cost<br /><strong>{money(lab.cost)}</strong></div>
          <div>Labor sell<br /><strong>{money(lab.billed)}</strong></div>
          <div>Labor margin<br /><strong>{lab.marginPct == null ? '—' : `${(lab.marginPct * 100).toFixed(1)}%`}</strong></div>
        </div>
      </div>
    </Card>
  );
}
