import React from 'react';
import { NumInput, MetricRow } from '../../components/ui.jsx';

// Shared device-hours grid used by both inspection calculators
export default function DeviceGrid({ devices, rows, onRow, withFreq, extra, results }) {
  return (
    <div className="device-grid-wrap">
      <div className="device-grid">
        <div className={'device-head' + (withFreq ? ' freq' : '')}>
          <span>Device</span><span>Hrs</span><span>Min</span><span>Count</span>{withFreq && <span>Freq</span>}
        </div>
        {devices.map((d) => {
          const r = rows[d.key];
          return (
            <div className={'device-row' + (withFreq ? ' freq' : '')} key={d.key}>
              <span className="cost-name">{d.label}{d.semi && <span className="hint"> semi-ann.</span>}</span>
              <NumInput value={r.hrs} onChange={(v) => onRow(d.key, { hrs: v })} step="1" />
              <NumInput value={r.mins} onChange={(v) => onRow(d.key, { mins: v })} step="1" max="59" />
              <NumInput value={r.count} onChange={(v) => onRow(d.key, { count: v })} step="1" placeholder="0" />
              {withFreq && (
                <select value={r.freq} onChange={(e) => onRow(d.key, { freq: Number(e.target.value) })}>
                  <option value={1}>Annual</option><option value={2}>Biannual</option><option value={4}>Quarterly</option>
                </select>
              )}
            </div>
          );
        })}
        {extra.map((x) => (
          <div className="device-extra" key={x.label}>
            <span className="cost-name">{x.label}</span>
            <NumInput value={x.value} onChange={x.onChange} min={x.min ?? 0} step={x.step ?? 0.5} />
          </div>
        ))}
      </div>
      <div className="device-results">
        <div className="section-label">Calculated hours</div>
        {results.map(([label, value], i) => (
          <MetricRow key={label} label={label} value={value} total={i === results.length - 3} />
        ))}
      </div>
    </div>
  );
}
