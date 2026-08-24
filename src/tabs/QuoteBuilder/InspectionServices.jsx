import React from 'react';
import { Card, Field, NumInput, CheckRow } from '../../components/ui.jsx';
import { calcFireInspection, calcPmInspection } from '../../lib/calc.js';
import { money } from '../../lib/format.js';

// Which inspection services this quote includes — the legacy's cb-nfpa, cb-pm and
// cb-pm-av-other toggles (index.html:7667-7760).
//
// These choose WHICH calculation runs, which makes them more consequential than a
// show/hide:
//
//   NFPA off  a single "inspection hours" figure, priced straight through
//   NFPA on   the itemised fire-inspection worksheet — devices x time, half-day
//             rounding, and extra technicians repeating the ANNUAL visit only
//   PM        the preventive-maintenance worksheet, where extra technicians
//             multiply the WHOLE visit instead
//   PM A/V    the same worksheet against A/V devices (displays, control systems,
//             racks) rather than life-safety devices
//
// Both worksheets are calcFireInspection / calcPmInspection in calc.js, covered by
// npm run parity:inspection. Nothing is computed here.

// legacy:7701 — the two PM device sets. Switching between them changes which rows
// the worksheet offers, not how it prices.
const PM_DEVICES = {
  standard: ['panels', 'keypads', 'motions', 'contacts', 'glass', 'sirens', 'readers', 'doors', 'cameras', 'rex', 'power'],
  av: ['displays', 'ctrlsys', 'audio', 'videodist', 'rack', 'network', 'cabling', 'software', 'complexity'],
};

const LABELS = {
  panels: 'Panels', keypads: 'Keypads', motions: 'Motions', contacts: 'Contacts',
  glass: 'Glass breaks', sirens: 'Sirens', readers: 'Readers', doors: 'Doors',
  cameras: 'Cameras', rex: 'REX devices', power: 'Power supplies',
  displays: 'Displays', ctrlsys: 'Control systems', audio: 'Audio', videodist: 'Video distribution',
  rack: 'Racks', network: 'Network', cabling: 'Cabling', software: 'Software', complexity: 'Complexity',
};

function DeviceRows({ keys, rows, onChange, showFrequency }) {
  const set = (key, patch) => onChange({ ...rows, [key]: { ...rows[key], ...patch } });
  return (
    <div style={{ display: 'grid', gridTemplateColumns: showFrequency ? '1fr auto auto auto auto' : '1fr auto auto auto', gap: '0.35rem', alignItems: 'center' }}>
      <span /><small>Qty</small><small>Hrs</small><small>Mins</small>{showFrequency && <small>Per yr</small>}
      {keys.map((k) => {
        const r = rows[k] || {};
        return (
          <React.Fragment key={k}>
            <label htmlFor={`insp-${k}-count`} style={{ fontSize: '0.88rem' }}>{LABELS[k] || k}</label>
            <NumInput id={`insp-${k}-count`} value={r.count ?? ''} onChange={(v) => set(k, { count: v })} min="0" step="1" style={{ width: '4.5rem' }} />
            <NumInput value={r.hrs ?? ''} onChange={(v) => set(k, { hrs: v })} min="0" step="any" style={{ width: '4.5rem' }} />
            <NumInput value={r.mins ?? ''} onChange={(v) => set(k, { mins: v })} min="0" max="59" step="1" style={{ width: '4.5rem' }} />
            {showFrequency && (
              <NumInput value={r.freq ?? 1} onChange={(v) => set(k, { freq: v })} min="1" step="1" style={{ width: '4.5rem' }} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

export default function InspectionServices({ value: insp, onChange, rates = {}, laborRate = 145 }) {
  const set = (patch) => onChange({ ...insp, ...patch });
  const laborCost = Number(rates.labor?.LaborCostPerHr) || 0;

  const fireRows = Object.entries(insp.fireRows || {}).map(([key, r]) => ({ ...r, semi: !!insp.fireSemi?.[key] }));
  const fire = insp.nfpa ? calcFireInspection(fireRows, insp.firePmHours, insp.fireTechs, laborCost, laborRate) : null;

  const pmKeys = insp.pmAvOther ? PM_DEVICES.av : PM_DEVICES.standard;
  const pmRows = pmKeys.map((k) => insp.pmRows?.[k]).filter(Boolean);
  const pm = insp.pm ? calcPmInspection(pmRows, insp.pmExtraHours, insp.pmTechs, laborCost, laborRate) : null;

  return (
    <Card title="Inspection &amp; Maintenance Services">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
        <CheckRow label="NFPA fire inspection (itemised)" checked={!!insp.nfpa}
          onChange={(on) => set({ nfpa: on })} />

        {/* With NFPA off the legacy shows a single hours figure instead — the same
            number, priced straight through, for jobs that do not need the worksheet. */}
        {!insp.nfpa && (
          <Field label="Annual inspection or PM service labor hours">
            <NumInput value={insp.simpleHours} onChange={(v) => set({ simpleHours: v })} min="0" step="any" />
          </Field>
        )}

        {insp.nfpa && (
          <div style={{ paddingLeft: '1.2rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <DeviceRows keys={['panels', 'pull', 'duct', 'notify', 'power', 'floors']}
              rows={insp.fireRows || {}} onChange={(fireRows) => set({ fireRows })} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
              <Field label="PM hours"><NumInput value={insp.firePmHours} onChange={(v) => set({ firePmHours: v })} min="0" step="any" /></Field>
              <Field label="Technicians"><NumInput value={insp.fireTechs} onChange={(v) => set({ fireTechs: v })} min="1" step="1" /></Field>
            </div>
            {fire && fire.totalHrs > 0 && (
              <p style={{ margin: 0, fontSize: '0.85rem' }}>
                {fire.totalHrs} hrs · cost {money(fire.laborCost)} · {money(fire.monthlyCharge)}/mo.
                {' '}Extra technicians repeat the annual visit only.
              </p>
            )}
          </div>
        )}

        <CheckRow label="Preventive maintenance" checked={!!insp.pm} onChange={(on) => set({ pm: on })} />

        {insp.pm && (
          <div style={{ paddingLeft: '1.2rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <CheckRow label="A/V devices instead of life-safety devices" checked={!!insp.pmAvOther}
              onChange={(on) => set({ pmAvOther: on })} />
            <DeviceRows keys={pmKeys} rows={insp.pmRows || {}} onChange={(pmRows) => set({ pmRows })} showFrequency />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
              <Field label="Extra hours"><NumInput value={insp.pmExtraHours} onChange={(v) => set({ pmExtraHours: v })} min="0" step="any" /></Field>
              <Field label="Technicians"><NumInput value={insp.pmTechs} onChange={(v) => set({ pmTechs: v })} min="1" step="1" /></Field>
            </div>
            {pm && pm.totalHrs > 0 && (
              <p style={{ margin: 0, fontSize: '0.85rem' }}>
                {pm.totalHrs} hrs · cost {money(pm.laborCost)} · {money(pm.monthlyCharge)}/mo.
                {' '}Extra technicians multiply the whole visit.
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

export const newInspectionServices = () => ({
  nfpa: false, simpleHours: '',
  fireRows: {}, fireSemi: {}, firePmHours: '', fireTechs: 1,
  pm: false, pmAvOther: false, pmRows: {}, pmExtraHours: '', pmTechs: 1,
});
