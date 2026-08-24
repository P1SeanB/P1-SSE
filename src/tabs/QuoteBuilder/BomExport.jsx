import React, { useState } from 'react';
import { billOfMaterials, bomColumns } from '../../lib/materials.js';
import { money } from '../../lib/format.js';

// Bill of materials export — the legacy's p1-bom-* overlay (index.html:15273+).
//
// Grouping, totals and column pruning all come from src/lib/materials.js, which is
// parity-verified. This file is presentation: a dialog, a CSV, a clipboard copy, and
// a print view.
//
// "Include costs" defaults ON but matters: the same sheet goes to a vendor for
// quoting AND to a project manager for budget. A vendor should not see what the job
// is charging for their parts, so the toggle is prominent rather than buried.

const COLUMN_LABELS = {
  vendor: 'Vendor', source: 'Source', partNumber: 'Part #',
  quoteNumber: 'Quote #', manufacturer: 'Manufacturer',
  chargeTo: 'Charge to', pkgUnit: 'Pkg unit',
};

// What the BOM is being charged against. The legacy asks before it exports, so a
// sheet arriving in someone's inbox already says which job it belongs to instead of
// prompting a reply asking.
const CHARGE_TARGETS = [
  { key: 'swo', label: 'SWO' },
  { key: 'seq', label: 'SEQ' },
  { key: 'phase', label: 'Phase' },
  { key: 'pm', label: 'PM' },
];

// RFC 4180: quote a field containing a comma, quote or newline, and escape embedded
// quotes by doubling. A part description with a comma in it is common enough that
// skipping this corrupts real exports.
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function buildRows(groups, columns, includeCosts) {
  const header = ['Qty', 'Unit', 'Description', ...columns.map((c) => COLUMN_LABELS[c] || c)];
  if (includeCosts) header.push('Unit cost', 'Line cost');

  const rows = [header];
  for (const g of groups) {
    rows.push([`— ${g.vendor} —`]);
    for (const l of g.lines) {
      const row = [l.qty, l.unit, l.desc, ...columns.map((c) => l[c] ?? '')];
      if (includeCosts) row.push(l.cost, l.lineTotal.toFixed(2));
      rows.push(row);
    }
    if (includeCosts) rows.push(['', '', `${g.vendor} subtotal`, ...columns.map(() => ''), '', g.cost.toFixed(2)]);
  }
  return rows;
}

export default function BomExport({ items, jobLabel = '', onClose }) {
  const [includeCosts, setIncludeCosts] = useState(true);
  const [chargeTo, setChargeTo] = useState({ type: '', value: '' });
  const [asking, setAsking] = useState(false);
  const [copied, setCopied] = useState('');

  const groups = billOfMaterials(items);
  const columns = bomColumns(items);
  const rows = buildRows(groups, columns, includeCosts);
  const grandCost = groups.reduce((s, g) => s + g.cost, 0);

  const heading = [jobLabel, chargeTo.type && `${chargeTo.type.toUpperCase()} ${chargeTo.value}`]
    .filter(Boolean).join(' · ');

  const csv = () => {
    const text = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
    // A BOM is a working file someone opens in Excel — a data: URL would be blocked
    // in some browsers and loses the filename, so use a blob and revoke it after.
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `BOM${jobLabel ? `-${jobLabel.replace(/[^a-zA-Z0-9._-]+/g, '-')}` : ''}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copy = async () => {
    // Tab-separated, because that is what pastes into Excel and into an email as a
    // table rather than as one run-on line.
    const text = rows.map((r) => r.join('\t')).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied('Copied — paste into an email or a spreadsheet.');
    } catch {
      setCopied('Could not copy. Select the table and copy manually.');
    }
    setTimeout(() => setCopied(''), 4000);
  };

  if (groups.length === 0) {
    return (
      <Overlay onClose={onClose}>
        <p style={{ margin: 0 }}>No materials to export yet. Add material lines first.</p>
      </Overlay>
    );
  }

  return (
    <Overlay onClose={onClose}>
      <div style={{
        display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap',
        borderBottom: '1px solid var(--border, #d8dbe0)', paddingBottom: '0.6rem', marginBottom: '0.8rem',
      }} className="bom-toolbar">
        <strong style={{ marginRight: 'auto' }}>Export BOM{heading ? ` — ${heading}` : ''}</strong>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem' }}>
          <input type="checkbox" checked={includeCosts} onChange={(e) => setIncludeCosts(e.target.checked)} />
          Include costs
        </label>
        <button type="button" onClick={() => setAsking(true)}>✎ Charge to…</button>
        <button type="button" onClick={csv}>Download CSV</button>
        <button type="button" onClick={copy}>Copy for email</button>
        <button type="button" onClick={() => window.print()}>Print / Save PDF</button>
        <button type="button" onClick={onClose}>✕ Close</button>
      </div>

      {copied && <div role="status" style={{ marginBottom: '0.6rem', fontSize: '0.85rem' }}>{copied}</div>}

      {asking && (
        <ChargeToDialog value={chargeTo}
          onCancel={() => setAsking(false)}
          onConfirm={(v) => { setChargeTo(v); setAsking(false); }} />
      )}

      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.88rem' }}>
          <thead>
            <tr>{rows[0].map((h, i) => (
              <th key={i} style={{ textAlign: i === 0 ? 'right' : 'left', padding: '0.3rem 0.5rem', borderBottom: '2px solid var(--border, #d8dbe0)' }}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <React.Fragment key={g.vendor}>
                <tr>
                  <td colSpan={rows[0].length} style={{ fontWeight: 700, padding: '0.5rem', background: 'var(--surface-2, #eef1f5)' }}>
                    {g.vendor}
                  </td>
                </tr>
                {g.lines.map((l, i) => (
                  <tr key={i}>
                    <td style={{ textAlign: 'right', padding: '0.25rem 0.5rem' }}>{l.qty}</td>
                    <td style={{ padding: '0.25rem 0.5rem' }}>{l.unit}</td>
                    <td style={{ padding: '0.25rem 0.5rem' }}>{l.desc}</td>
                    {columns.map((c) => <td key={c} style={{ padding: '0.25rem 0.5rem' }}>{l[c] ?? ''}</td>)}
                    {includeCosts && <td style={{ textAlign: 'right', padding: '0.25rem 0.5rem' }}>{money(l.cost)}</td>}
                    {includeCosts && <td style={{ textAlign: 'right', padding: '0.25rem 0.5rem' }}>{money(l.lineTotal)}</td>}
                  </tr>
                ))}
                {includeCosts && (
                  <tr>
                    <td colSpan={rows[0].length - 1} style={{ textAlign: 'right', padding: '0.25rem 0.5rem', fontStyle: 'italic' }}>
                      {g.vendor} subtotal
                    </td>
                    <td style={{ textAlign: 'right', padding: '0.25rem 0.5rem', fontWeight: 600 }}>{money(g.cost)}</td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
          {includeCosts && (
            <tfoot>
              <tr>
                <td colSpan={rows[0].length - 1} style={{ textAlign: 'right', padding: '0.5rem', fontWeight: 700, borderTop: '2px solid var(--border, #d8dbe0)' }}>
                  Total
                </td>
                <td style={{ textAlign: 'right', padding: '0.5rem', fontWeight: 700, borderTop: '2px solid var(--border, #d8dbe0)' }}>
                  {money(grandCost)}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </Overlay>
  );
}

function ChargeToDialog({ value, onCancel, onConfirm }) {
  const [type, setType] = useState(value.type || 'swo');
  const [text, setText] = useState(value.value || '');

  return (
    <div style={{
      border: '1px solid var(--border, #d8dbe0)', borderRadius: 8, padding: '0.75rem',
      marginBottom: '0.8rem', display: 'flex', gap: '0.5rem', alignItems: 'end', flexWrap: 'wrap',
    }}>
      <div>
        <div style={{ fontSize: '0.8rem', marginBottom: '0.25rem' }}>Charge this BOM to</div>
        <div style={{ display: 'flex', gap: '0.3rem' }}>
          {CHARGE_TARGETS.map((t) => (
            <button key={t.key} type="button" onClick={() => setType(t.key)}
              aria-pressed={type === t.key}
              style={{ fontWeight: type === t.key ? 700 : 400 }}>{t.label}</button>
          ))}
        </div>
      </div>
      <div>
        <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem' }} htmlFor="bom-charge-value">
          Number
        </label>
        <input id="bom-charge-value" value={text} onChange={(e) => setText(e.target.value)}
          placeholder="e.g. 26-151" />
      </div>
      <button type="button" onClick={() => onConfirm({ type, value: text.trim() })}>Apply</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  );
}

function Overlay({ children, onClose }) {
  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '2rem 1rem', overflowY: 'auto',
      }}
    >
      <div style={{
        background: 'var(--surface, #fff)', color: 'var(--ink, #161c26)',
        borderRadius: 10, padding: '1rem', width: 'min(60rem, 100%)',
      }}>
        {children}
      </div>
    </div>
  );
}
