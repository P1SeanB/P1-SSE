import React from 'react';
import { money } from '../lib/format.js';

export function Card({ title, children, style }) {
  return (
    <div className="card" style={style}>
      {title && <div className="card-title">{title}</div>}
      {children}
    </div>
  );
}

export function Field({ label, children }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

export function TextInput({ value, onChange, ...rest }) {
  return <input type="text" value={value} onChange={(e) => onChange(e.target.value)} {...rest} />;
}

export function NumInput({ value, onChange, ...rest }) {
  return (
    <input
      type="number"
      min="0"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="0.00"
      {...rest}
    />
  );
}

// Range slider with label/value header, mirrors the legacy slider blocks
export function Slider({ label, value, onChange, min, max, step = 1, format = (v) => v }) {
  return (
    <div className="slider-block">
      <div className="slider-head">
        <label>{label}</label>
        <span className="slider-val">{format(value)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <div className="slider-range"><span>{format(min)}</span><span>{format(max)}</span></div>
    </div>
  );
}

export function MetricRow({ label, value, total }) {
  return (
    <div className={'metric-row' + (total ? ' total' : '')}>
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
    </div>
  );
}

export function BigMetric({ label, value, sub, color }) {
  return (
    <div className="big-metric">
      <div className="big-metric-label">{label}</div>
      <div className="big-metric-value" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="big-metric-sub">{sub}</div>}
    </div>
  );
}

export function SectionLabel({ children }) {
  return <div className="section-label">{children}</div>;
}

// Checkbox line item with a $ value on the right (legacy .cb-row)
export function CheckRow({ label, checked, onChange, amount }) {
  return (
    <div className="cb-row">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <label className="cb-name" onClick={() => onChange(!checked)}>{label}</label>
      <span className={'cb-value' + (checked ? ' checked' : '')}>{money(checked ? amount : 0)}</span>
    </div>
  );
}

// <select> whose options come from the rates payload (PricingOption table).
// Replaces the legacy dropdownsHTML innerHTML injection (legacy:7432-7439).
export function RateSelect({ group, options, value, onChange, placeholder = '— Select —', ...rest }) {
  const opts = options?.[group] || [];
  return (
    <select
      value={value}
      // The matched option is passed as a second argument. Some dropdowns carry more
      // than a price — the Alarm.com video tiers carry a TYPE (flat / per-camera /
      // expansion) that decides how the tier is charged, and a caller that only
      // received the value would have to re-find the option to learn it.
      onChange={(e) => onChange(e.target.value, opts.find((o) => String(o.value) === e.target.value))}
      {...rest}
    >
      <option value="">{placeholder}</option>
      {opts.map((o) => (
        <option key={o.value + o.label} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

// Price of the selected option within a dropdown group
export function optionPrice(options, group, value) {
  const opt = (options?.[group] || []).find((o) => String(o.value) === String(value));
  return opt ? Number(opt.price) || 0 : 0;
}
