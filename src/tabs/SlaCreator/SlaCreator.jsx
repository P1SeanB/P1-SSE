import React, { useState } from 'react';
import { useAppState } from '../../store/AppState.jsx';
import { slaRateTable } from '../../lib/calc.js';
import {
  slaRate, slaEndDate, TERM_OPTIONS, BILLING_CYCLES, RESPONSE_TIERS,
} from '../../lib/sla.js';
import { money, num } from '../../lib/format.js';
import {
  Card, Field, TextInput, NumInput, SectionLabel, MetricRow,
} from '../../components/ui.jsx';

// SLA creator — the legacy's sla-* section.
//
// This replaces an earlier simplified port that offered ONE "included labor hours"
// line at a single tier rate. The legacy has three independently-rated budget lines
// (regular, after hours, emergency), a selectable PM visit count, split triage and
// on-site response commitments, and the agreement terms that print on the document.
// Collapsing those loses real capability: an agreement covering 40 regular hours and
// 4 emergency hours cannot be expressed as a single number at a single rate.
//
// All arithmetic is src/lib/sla.js, covered by npm run parity:sla.

const SLA_SYSTEMS = ['Fire', 'Burglar', 'Access Control', 'Video', 'AV', 'Nurse Call', 'Intercom'];
const TIERS = ['Standard', 'Priority', 'Premier'];
const FREQS = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'annual', label: 'Annual' },
];
// The legacy offers these as four buttons (sla-visit-btn-1..4).
const VISIT_COUNTS = [1, 2, 3, 4];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

export default function SlaCreator({ rates }) {
  const { customer, updateCustomer, sites } = useAppState();
  const site1 = sites[0] || {};

  const [systems, setSystems] = useState([]);
  const [tier, setTier] = useState('Standard');
  const [frequency, setFrequency] = useState('monthly');

  // Agreement identity and term
  const [agreementNumber, setAgreementNumber] = useState('');
  const [agreementDate, setAgreementDate] = useState('');
  const [startDate, setStartDate] = useState('');
  const [termMonths, setTermMonths] = useState(12);
  const [customMonths, setCustomMonths] = useState('');
  const [autoRenew, setAutoRenew] = useState(true);
  const [billingCycle, setBillingCycle] = useState('monthly');

  // Budget — three independently-rated lines, matching the legacy
  const [budget, setBudget] = useState({
    regularHours: '', regularRate: '',
    afterHoursHours: '', afterHoursRate: '',
    emergencyHours: '', emergencyRate: '',
    materialsAmount: '',
  });

  // Preventive maintenance
  const [pmHours, setPmHours] = useState('');
  const [pmVisits, setPmVisits] = useState(1);
  const [calMonth, setCalMonth] = useState('');
  const [calYear, setCalYear] = useState('');

  // Response commitments — triage AND on-site per severity
  const [response, setResponse] = useState({
    reg: { triage: '', onsite: '' },
    ah: { triage: '', onsite: '' },
    em: { triage: '', onsite: '' },
  });

  const [notes, setNotes] = useState('');

  const effectiveTerm = termMonths === 'custom' ? parseInt(customMonths, 10) || 0 : termMonths;
  const endDate = slaEndDate(startDate, effectiveTerm);

  const table = slaRateTable(rates);
  const tierRates = table ? table[tier.toLowerCase()] : null;

  // Rates default from the selected tier, but stay editable — an agreement is
  // negotiated, and the legacy lets an estimator type over the default.
  const rateFor = (key, fallback) =>
    budget[key] !== '' ? budget[key] : fallback ?? '';

  const priced = slaRate(
    {
      regularHours: budget.regularHours,
      regularRate: rateFor('regularRate', tierRates?.straight),
      afterHoursHours: budget.afterHoursHours,
      afterHoursRate: rateFor('afterHoursRate', tierRates?.timeAndHalf),
      emergencyHours: budget.emergencyHours,
      emergencyRate: rateFor('emergencyRate', tierRates?.doubleTime),
      materialsAmount: budget.materialsAmount,
      pmHours, pmVisits, frequency,
    },
    rates,
  );

  const setBudgetField = (patch) => setBudget({ ...budget, ...patch });
  const setResp = (tierKey, patch) =>
    setResponse({ ...response, [tierKey]: { ...response[tierKey], ...patch } });

  const toggleSystem = (s) =>
    setSystems(systems.includes(s) ? systems.filter((x) => x !== s) : [...systems, s]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <Card title="1 · Customer Information">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
          <Field label="Company name"><TextInput value={customer.companyName} onChange={(v) => updateCustomer({ companyName: v })} /></Field>
          <Field label="Contact"><TextInput value={customer.contactName} onChange={(v) => updateCustomer({ contactName: v })} /></Field>
          <Field label="Site address">
            <input readOnly value={[site1.address, site1.city, site1.state].filter(Boolean).join(', ')} />
          </Field>
          <Field label="Email"><TextInput value={customer.email} onChange={(v) => updateCustomer({ email: v })} /></Field>
        </div>
      </Card>

      <Card title="2 · Agreement">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(10rem,1fr))', gap: '0.6rem' }}>
          <Field label="Agreement #"><TextInput value={agreementNumber} onChange={setAgreementNumber} /></Field>
          <Field label="Agreement date">
            <input type="date" value={agreementDate} onChange={(e) => setAgreementDate(e.target.value)} />
          </Field>
          <Field label="Start date">
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </Field>
          <Field label="Term">
            <select value={termMonths} onChange={(e) => setTermMonths(e.target.value === 'custom' ? 'custom' : Number(e.target.value))}>
              {TERM_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
          {termMonths === 'custom' && (
            <Field label="Custom months">
              <NumInput value={customMonths} onChange={setCustomMonths} min="1" step="1" />
            </Field>
          )}
          {/* Derived, never typed — the end date is the day BEFORE the anniversary,
              and letting someone type it is how a signed agreement ends up with a
              term that does not match its own dates. */}
          <Field label="End date">
            <input readOnly value={endDate || '—'} aria-label="End date, calculated from the start date and term" />
          </Field>
          <Field label="Billing cycle">
            <select value={billingCycle} onChange={(e) => setBillingCycle(e.target.value)}>
              {BILLING_CYCLES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
            </select>
          </Field>
          <Field label="Auto-renew">
            <label style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <input type="checkbox" checked={autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} />
              <span>Renews automatically at term end</span>
            </label>
          </Field>
        </div>
      </Card>

      <Card title="3 · Systems Covered">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
          {SLA_SYSTEMS.map((s) => (
            <label key={s} style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
              <input type="checkbox" checked={systems.includes(s)} onChange={() => toggleSystem(s)} />
              <span>{s}</span>
            </label>
          ))}
        </div>
      </Card>

      <Card title="4 · Service Tier">
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {TIERS.map((t) => (
            <button key={t} type="button" onClick={() => setTier(t)}
              aria-pressed={tier === t}
              style={{ fontWeight: tier === t ? 700 : 400 }}>
              {t}
            </button>
          ))}
        </div>
        {tierRates && (
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem' }}>
            Straight {money(tierRates.straight)}/hr · Time and a half {money(tierRates.timeAndHalf)}/hr ·
            Double time {money(tierRates.doubleTime)}/hr
          </p>
        )}
      </Card>

      <Card title="5 · Service Budget">
        <p style={{ margin: '0 0 0.6rem', fontSize: '0.85rem', color: 'var(--text-muted, #6b7688)' }}>
          Hours included each year, at the rate they are drawn down at. Rates default from
          the selected tier and can be negotiated per agreement. A line with hours but no
          rate — or a rate but no hours — is not yet counted.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr 1fr', gap: '0.5rem', alignItems: 'end' }}>
          <SectionLabel>Regular</SectionLabel>
          <Field label="Hours / yr"><NumInput value={budget.regularHours} onChange={(v) => setBudgetField({ regularHours: v })} min="0" step="any" /></Field>
          <Field label="Rate / hr"><NumInput value={rateFor('regularRate', tierRates?.straight)} onChange={(v) => setBudgetField({ regularRate: v })} min="0" step="0.01" /></Field>
          <div style={{ paddingBottom: '0.4rem' }}>{priced.regular > 0 ? money(priced.regular) : '—'}</div>

          <SectionLabel>After hours</SectionLabel>
          <Field label="Hours / yr"><NumInput value={budget.afterHoursHours} onChange={(v) => setBudgetField({ afterHoursHours: v })} min="0" step="any" /></Field>
          <Field label="Rate / hr"><NumInput value={rateFor('afterHoursRate', tierRates?.timeAndHalf)} onChange={(v) => setBudgetField({ afterHoursRate: v })} min="0" step="0.01" /></Field>
          <div style={{ paddingBottom: '0.4rem' }}>{priced.afterHours > 0 ? money(priced.afterHours) : '—'}</div>

          <SectionLabel>Emergency</SectionLabel>
          <Field label="Hours / yr"><NumInput value={budget.emergencyHours} onChange={(v) => setBudgetField({ emergencyHours: v })} min="0" step="any" /></Field>
          <Field label="Rate / hr"><NumInput value={rateFor('emergencyRate', tierRates?.doubleTime)} onChange={(v) => setBudgetField({ emergencyRate: v })} min="0" step="0.01" /></Field>
          <div style={{ paddingBottom: '0.4rem' }}>{priced.emergency > 0 ? money(priced.emergency) : '—'}</div>
        </div>

        <div style={{ marginTop: '0.6rem' }}>
          <Field label="Annual materials budget">
            <TextInput value={budget.materialsAmount} onChange={(v) => setBudgetField({ materialsAmount: v })} placeholder="$0.00" />
          </Field>
        </div>
      </Card>

      <Card title="6 · Preventive Maintenance">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(9rem,1fr))', gap: '0.6rem' }}>
          <Field label="Visits / yr">
            <div style={{ display: 'flex', gap: '0.3rem' }}>
              {VISIT_COUNTS.map((n) => (
                <button key={n} type="button" onClick={() => setPmVisits(n)}
                  aria-pressed={pmVisits === n}
                  style={{ fontWeight: pmVisits === n ? 700 : 400 }}>{n}</button>
              ))}
            </div>
          </Field>
          <Field label="Hours / visit"><NumInput value={pmHours} onChange={setPmHours} min="0" step="any" /></Field>
          <Field label="First visit month">
            <select value={calMonth} onChange={(e) => setCalMonth(e.target.value)}>
              <option value="">— Select —</option>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </Field>
          <Field label="Year"><NumInput value={calYear} onChange={setCalYear} min="2020" step="1" /></Field>
        </div>
        {/* PM is billed at the standard straight rate whatever the tier — saying so
            stops it reading as a pricing bug on a Premier agreement. */}
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: 'var(--text-muted, #6b7688)' }}>
          {priced.pm > 0
            ? `${pmVisits} visit${pmVisits > 1 ? 's' : ''} × ${num(pmHours)} hrs = ${money(priced.pm)}/yr, billed at the standard rate for every tier.`
            : 'Preventive maintenance is billed at the standard rate for every tier.'}
        </p>
      </Card>

      <Card title="7 · Response Time Commitments">
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr', gap: '0.5rem', alignItems: 'end' }}>
          <div />
          <SectionLabel>Triage</SectionLabel>
          <SectionLabel>On site</SectionLabel>
          {RESPONSE_TIERS.map((t) => (
            <React.Fragment key={t.key}>
              <SectionLabel>{t.label}</SectionLabel>
              <TextInput value={response[t.key].triage} onChange={(v) => setResp(t.key, { triage: v })} placeholder="e.g. 1 hour" />
              <TextInput value={response[t.key].onsite} onChange={(v) => setResp(t.key, { onsite: v })} placeholder="e.g. 4 hours" />
            </React.Fragment>
          ))}
        </div>
      </Card>

      <Card title="8 · Notes">
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4}
          style={{ width: '100%' }} placeholder="Exclusions, special terms, anything that should print on the agreement" />
      </Card>

      <Card title="SLA Summary">
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.6rem' }}>
          {FREQS.map((f) => (
            <button key={f.value} type="button" onClick={() => setFrequency(f.value)}
              aria-pressed={frequency === f.value}
              style={{ fontWeight: frequency === f.value ? 700 : 400 }}>{f.label}</button>
          ))}
        </div>
        <MetricRow label="Regular labor" value={priced.regular > 0 ? `${money(priced.regular)}/yr` : '—'} />
        <MetricRow label="After hours" value={priced.afterHours > 0 ? `${money(priced.afterHours)}/yr` : '—'} />
        <MetricRow label="Emergency" value={priced.emergency > 0 ? `${money(priced.emergency)}/yr` : '—'} />
        <MetricRow label="Preventive maintenance" value={priced.pm > 0 ? `${money(priced.pm)}/yr` : '—'} />
        <MetricRow label="Materials" value={priced.materials > 0 ? `${money(priced.materials)}/yr` : '—'} />
        <MetricRow label="Annual total" value={priced.annual > 0 ? `${money(priced.annual)}/yr` : '—'} />
        <MetricRow total
          label={`SLA rate (${FREQS.find((f) => f.value === frequency)?.label.toLowerCase()})`}
          value={priced.display > 0 ? money(priced.display) : '—'} />
        <MetricRow
          label="Contract value"
          value={priced.annual > 0 && effectiveTerm > 0
            ? `${money((priced.annual * effectiveTerm) / 12)} over ${effectiveTerm} months`
            : '—'} />
      </Card>
    </div>
  );
}
