import React, { useState } from 'react';
import MaterialRows from './MaterialRows.jsx';
import TmSubRows from './TmSubRows.jsx';
import RentalEquipment from './RentalEquipment.jsx';
import BomExport from './BomExport.jsx';
import { Card, SectionLabel, MetricRow } from '../../components/ui.jsx';
import { money } from '../../lib/format.js';

// The one-time half of a quote, in one place: what is installed, who installs it,
// what was hired to do it, and what the customer pays once.
//
// Everything here existed as a component before it existed on screen. MaterialRows,
// TmSubRows, BomExport and EstimateDetails were written in Aug 2026, mapped as done,
// and imported by nothing — npm run coverage said 375/375 while vite build was
// transforming 29 modules and none of them were these. This container is what makes
// them ship.
//
// It holds no arithmetic. Every number comes from useOneTimeWork, which delegates to
// src/lib/materials.js and src/lib/rental.js, both parity-verified.

export default function OneTimeWork({ work, charges = {}, rates = {}, jobLabel = '' }) {
  const [bomOpen, setBomOpen] = useState(false);

  const oneTime = work.totals(charges);
  const materials = work.priced.filter((i) => i.type === 'material');

  return (
    <>
      <MaterialRows
        rows={work.rows}
        onRowsChange={work.setRows}
        matMarkup={work.matMarkup}
        onMarkupChange={work.setMatMarkup}
        rates={rates}
      />

      <TmSubRows
        rows={work.tmSubRows}
        onRowsChange={work.setTmSubRows}
        tmSubGM={work.tmSubGM}
        onGmChange={work.setTmSubGM}
      />

      <RentalEquipment value={work.rental} onChange={work.setRental} />

      {/* A bill of materials is only a thing once there are materials to buy. The
          legacy offers the button always and opens an empty sheet. */}
      {materials.length > 0 && (
        <Card title="Bill of materials">
          <p style={{ margin: '0 0 0.6rem', fontSize: '0.9rem', color: 'var(--text-muted, #6b7688)' }}>
            {materials.length} line{materials.length === 1 ? '' : 's'} across{' '}
            {new Set(materials.map((m) => (m.vendor || '').trim() || 'Unassigned')).size} vendor(s).
          </p>
          <button type="button" onClick={() => setBomOpen(true)}>Export bill of materials</button>
        </Card>
      )}

      {bomOpen && (
        <BomExport items={work.priced} jobLabel={jobLabel} onClose={() => setBomOpen(false)} />
      )}

      {oneTime.total > 0 && (
        <Card title="One-time total">
          <SectionLabel>What the customer pays once</SectionLabel>
          <MetricRow label="Materials" value={money(oneTime.materialsBilled)} />
          <MetricRow label="Installation labor" value={money(oneTime.laborBilled)} />
          {oneTime.subBilled > 0 && <MetricRow label="Subcontract" value={money(oneTime.subBilled)} />}
          {oneTime.rentalBilled > 0 && <MetricRow label="Rental equipment" value={money(oneTime.rentalBilled)} />}
          {oneTime.materialTax > 0 && <MetricRow label="Material sales tax" value={money(oneTime.materialTax)} />}
          {oneTime.shippingBilled > 0 && <MetricRow label="Shipping" value={money(oneTime.shippingBilled)} />}
          <MetricRow total label="One-time total" value={money(oneTime.total)} />
          {/* Stated because it is the question every review asks, and because the
              answer is not the obvious one — see computeOneTimeTotal. */}
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.8rem', color: 'var(--text-muted, #6b7688)' }}>
            Sales tax applies to materials only. Shipping and rental carry their own markups.
          </p>
        </Card>
      )}
    </>
  );
}
