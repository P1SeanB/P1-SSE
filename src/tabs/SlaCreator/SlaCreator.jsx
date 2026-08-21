import React, { useMemo, useState } from 'react';
import { useAppState } from '../../store/AppState.jsx';
import { slaRateTable, slaDisplayFromMonthly, slaMonthlyFromDisplay } from '../../lib/calc.js';
import { money, num } from '../../lib/format.js';
import { Card, Field, TextInput, NumInput, SectionLabel, MetricRow } from '../../components/ui.jsx';

// Systems covered — legacy SLA "Systems Covered" cards (:2671-2700)
const SLA_SYSTEMS = [
  'Fire Alarm', 'Burglar Alarm', 'Access Control', 'Video Surveillance',
  'Intercom', 'Audio/Visual', 'Networking', 'Two-Way Communication',
];

const TIERS = ['Standard', 'Priority', 'Premier'];
const FREQS = [
  { id: 'monthly', label: 'Mo' },
  { id: 'quarterly', label: 'Qtr' },
  { id: 'annual', label: 'Yr' },
];

export default function SlaCreator({ rates }) {
  const { customer, updateCustomer, sites } = useAppState();
  const site1 = sites[0];
  const rateTable = useMemo(() => slaRateTable(rates), [rates]);
  const tiers = rates?.tiers || [];
  const pmVisitRate = Number(rates?.misc?.pmVisitRate) || 0;

  const [systems, setSystems] = useState([]);
  const [tier, setTier] = useState('Standard');
  // Budget — SLA fee with frequency toggle (legacy slaSetFreq/slaRateInput :8430-8510)
  const [freq, setFreq] = useState('monthly');
  const [monthlyBase, setMonthlyBase] = useState(0);
  // Labor budget rows: included hours × rate (legacy slaBudgetCalc :8522)
  const [laborHrs, setLaborHrs] = useState('');
  const [materialsBudget, setMaterialsBudget] = useState('');
  const [pmVisits, setPmVisits] = useState('');
  const [termMonths, setTermMonths] = useState(36);
  const [responseTimes, setResponseTimes] = useState({ emergency: '4 hours', urgent: '8 hours', standard: 'Next business day' });

  const toggleSystem = (s) =>
    setSystems((list) => (list.includes(s) ? list.filter((x) => x !== s) : [...list, s]));

  const displayVal = slaDisplayFromMonthly(monthlyBase, freq);
  const tierRow = tiers.find((t) => t.TierName === tier);
  const tierHourly = tierRow ? Number(tierRow.Rate) : (rateTable ? rateTable[tier.toLowerCase()]?.straight : 0);

  const laborBudget = num(laborHrs) * (tierHourly || 0);
  const pmBudget = num(pmVisits) * pmVisitRate;
  const annualTotal = monthlyBase * 12;

  return (
    <div className="qb-layout">
      <div className="qb-left">
        <Card title="1 · Customer Information">
          <p className="hint">Fields synced from Quote Builder — edit customer info there to update here.</p>
          <div className="grid-2">
            <Field label="Company name"><TextInput value={customer.companyName} onChange={(v) => updateCustomer({ companyName: v })} /></Field>
            <Field label="Contact"><TextInput value={customer.contactName} onChange={(v) => updateCustomer({ contactName: v })} /></Field>
          </div>
          <div className="grid-2">
            <Field label="Site address"><input readOnly value={[site1.address, site1.city, site1.state].filter(Boolean).join(', ') || '—'} /></Field>
            <Field label="Email"><TextInput value={customer.email} onChange={(v) => updateCustomer({ email: v })} /></Field>
          </div>
        </Card>

        <Card title="2 · Systems Covered">
          <div className="chip-row">
            {SLA_SYSTEMS.map((s) => (
              <button key={s} type="button" className={'chip' + (systems.includes(s) ? ' active' : '')} onClick={() => toggleSystem(s)}>
                {s}
              </button>
            ))}
          </div>
        </Card>

        <Card title="3 · Service Tier">
          <div className="chip-row">
            {TIERS.map((t) => (
              <button key={t} type="button" className={'chip' + (tier === t ? ' active' : '')} onClick={() => setTier(t)}>{t}</button>
            ))}
          </div>
          {rateTable && (
            <table className="rate-table">
              <thead><tr><th></th><th>Straight</th><th>1.5×</th><th>2×</th></tr></thead>
              <tbody>
                {['standard', 'priority', 'premier'].map((k) => (
                  <tr key={k} className={tier.toLowerCase() === k ? 'active' : ''}>
                    <td style={{ textTransform: 'capitalize' }}>{k}</td>
                    <td>{money(rateTable[k].straight)}</td>
                    <td>{money(rateTable[k].timeAndHalf)}</td>
                    <td>{money(rateTable[k].doubleTime)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="hint">PM visits (all tiers): {money(pmVisitRate)}/hr</p>
        </Card>

        <Card title="4 · Service Budget">
          <div className="oh-row">
            <label>SLA fee</label>
            <div className="oh-toggle">
              {FREQS.map((f) => (
                <button key={f.id} className={freq === f.id ? 'active' : ''} onClick={() => setFreq(f.id)}>{f.label}</button>
              ))}
            </div>
            <NumInput
              value={displayVal > 0 ? displayVal.toFixed(2) : ''}
              onChange={(v) => setMonthlyBase(slaMonthlyFromDisplay(num(v), freq))}
              step="0.01"
              style={{ width: 120 }}
            />
            <span className="hint">per {freq === 'monthly' ? 'month' : freq === 'quarterly' ? 'quarter' : 'year'}</span>
          </div>
          <div className="grid-3">
            <Field label={`Included labor hours (@ ${money(tierHourly || 0)}/hr)`}><NumInput value={laborHrs} onChange={setLaborHrs} step="1" /></Field>
            <Field label="Annual materials budget ($)"><NumInput value={materialsBudget} onChange={setMaterialsBudget} step="0.01" /></Field>
            <Field label={`PM visit hours (@ ${money(pmVisitRate)}/hr)`}><NumInput value={pmVisits} onChange={setPmVisits} step="1" /></Field>
          </div>
        </Card>

        <Card title="5 · Response Time Commitments">
          <div className="grid-3">
            {Object.entries(responseTimes).map(([k, v]) => (
              <Field key={k} label={k[0].toUpperCase() + k.slice(1)}>
                <select value={v} onChange={(e) => setResponseTimes((r) => ({ ...r, [k]: e.target.value }))}>
                  <option>2 hours</option><option>4 hours</option><option>8 hours</option>
                  <option>Next business day</option><option>48 hours</option>
                </select>
              </Field>
            ))}
          </div>
        </Card>

        <Card title="6 · Contract Terms">
          <div className="grid-2">
            <Field label="Term (months)">
              <select value={termMonths} onChange={(e) => setTermMonths(Number(e.target.value))}>
                <option value={12}>12</option><option value={24}>24</option>
                <option value={36}>36</option><option value={60}>60</option>
              </select>
            </Field>
          </div>
          <p className="hint">Exclusions/billing notes, PM checklist builder, and signature blocks are tracked as follow-up ports from the legacy SLA document generator.</p>
        </Card>
      </div>

      <div className="qb-right">
        <Card title="SLA Summary">
          <div className="quote-summary" style={{ marginTop: 0 }}>
            <div className="quote-summary-title">SLA pricing</div>
            <div className="qs-label">{tier} tier</div>
            <div className="qs-rmr">{monthlyBase > 0 ? money(monthlyBase) + '/mo' : '—'}</div>
            <div className="qs-sub">{systems.length ? systems.join(' · ') : 'no systems selected'}</div>
            <MetricRow label="Annual SLA fee" value={annualTotal > 0 ? money(annualTotal) : '—'} />
            <MetricRow label="Included labor budget" value={laborBudget > 0 ? money(laborBudget) + '/yr' : '—'} />
            <MetricRow label="Materials budget" value={num(materialsBudget) > 0 ? money(num(materialsBudget)) + '/yr' : '—'} />
            <MetricRow label="PM visit budget" value={pmBudget > 0 ? money(pmBudget) + '/yr' : '—'} />
            <MetricRow total label="Contract value" value={annualTotal > 0 ? money(annualTotal * termMonths / 12) + ` / ${termMonths} mo` : '—'} />
          </div>
        </Card>
      </div>
    </div>
  );
}
