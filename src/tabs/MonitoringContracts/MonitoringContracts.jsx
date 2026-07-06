import React, { useState } from 'react';
import { useAppState, lookupZip } from '../../store/AppState.jsx';
import { money, num } from '../../lib/format.js';
import { Card, Field, TextInput, NumInput } from '../../components/ui.jsx';

// Comm methods / services per site — legacy MC site cards (:10646-10647)
const COMM_METHODS = ['Cellular', 'IP', 'POTS', 'Radio'];
const SITE_SERVICES = ['Fire', 'Burglar', 'Access', 'Video', 'Two-Way', 'Environmental'];

let agreementSeq = 1;

export default function MonitoringContracts() {
  const { customer, updateCustomer, sites, updateSite, addSite, removeSite } = useAppState();
  const [agreements, setAgreements] = useState([]);

  const addAgreement = () =>
    setAgreements((l) => [...l, { id: 'a' + agreementSeq++, name: '', siteIds: [], termMonths: 36, notes: '' }]);
  const updateAgreement = (id, patch) =>
    setAgreements((l) => l.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const removeAgreement = (id) => setAgreements((l) => l.filter((a) => a.id !== id));

  const toggleAgreementSite = (a, siteId) =>
    updateAgreement(a.id, {
      siteIds: a.siteIds.includes(siteId) ? a.siteIds.filter((x) => x !== siteId) : [...a.siteIds, siteId],
    });

  const monthlyTotal = sites.reduce((s, x) => s + num(x.monthlyRate), 0);

  async function onZipBlur(site, zip) {
    const found = await lookupZip(zip);
    if (found) updateSite(site.id, { city: found.city, state: found.state });
  }

  return (
    <div className="qb-layout">
      <div className="qb-left">
        <Card title="1 · Customer Information">
          <p className="hint">Synced with the Quote Builder tab.</p>
          <div className="grid-2">
            <Field label="Company name"><TextInput value={customer.companyName} onChange={(v) => updateCustomer({ companyName: v })} /></Field>
            <Field label="Contact"><TextInput value={customer.contactName} onChange={(v) => updateCustomer({ contactName: v })} /></Field>
          </div>
          <div className="grid-2">
            <Field label="Phone"><TextInput value={customer.phone} onChange={(v) => updateCustomer({ phone: v })} /></Field>
            <Field label="Email"><TextInput value={customer.email} onChange={(v) => updateCustomer({ email: v })} /></Field>
          </div>
          <div className="subsection">
            <div className="subsection-head">
              <span className="mono-label">Billing Address</span>
              <label className="hint" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={customer.billSameAsSite1} onChange={(e) => updateCustomer({ billSameAsSite1: e.target.checked })} />
                {' '}Same as Site 1 address
              </label>
            </div>
            {!customer.billSameAsSite1 && (
              <div className="grid-3">
                <Field label="Street"><TextInput value={customer.billAddr} onChange={(v) => updateCustomer({ billAddr: v })} /></Field>
                <Field label="City"><TextInput value={customer.billCity} onChange={(v) => updateCustomer({ billCity: v })} /></Field>
                <Field label="State / ZIP">
                  <div style={{ display: 'flex', gap: 8 }}>
                    <TextInput value={customer.billState} onChange={(v) => updateCustomer({ billState: v.toUpperCase() })} maxLength={2} style={{ width: 60 }} />
                    <TextInput value={customer.billZip} onChange={(v) => updateCustomer({ billZip: v })} maxLength={10} />
                  </div>
                </Field>
              </div>
            )}
          </div>
        </Card>

        <Card title="2 · Sites / Service Addresses">
          <p className="hint">Sites are shared with the Quote Builder tab — edits here update there instantly.</p>
          {sites.map((s, i) => (
            <div className="mc-site-card" key={s.id}>
              <div className="subsection-head">
                <span className="mono-label">Site {i + 1}</span>
                {i > 0 && <button type="button" className="btn-x" onClick={() => removeSite(s.id)}>×</button>}
              </div>
              <Field label="Address"><TextInput value={s.address} onChange={(v) => updateSite(s.id, { address: v })} placeholder="123 Main St" /></Field>
              <div className="grid-3">
                <Field label="City"><TextInput value={s.city} onChange={(v) => updateSite(s.id, { city: v })} /></Field>
                <Field label="State"><TextInput value={s.state} onChange={(v) => updateSite(s.id, { state: v.toUpperCase() })} maxLength={2} /></Field>
                <Field label="ZIP"><TextInput value={s.zip} onChange={(v) => updateSite(s.id, { zip: v })} onBlur={(e) => onZipBlur(s, e.target.value)} maxLength={10} /></Field>
              </div>
              <div className="grid-3">
                <Field label="Monthly rate ($)"><NumInput value={s.monthlyRate} onChange={(v) => updateSite(s.id, { monthlyRate: v })} step="0.01" /></Field>
                <Field label="Comm methods">
                  <div className="chip-row">
                    {COMM_METHODS.map((c) => (
                      <button key={c} type="button"
                        className={'chip sm' + ((s.comm || []).includes(c) ? ' active' : '')}
                        onClick={() => updateSite(s.id, { comm: (s.comm || []).includes(c) ? (s.comm || []).filter((x) => x !== c) : [...(s.comm || []), c] })}>
                        {c}
                      </button>
                    ))}
                  </div>
                </Field>
                <Field label="Services">
                  <div className="chip-row">
                    {SITE_SERVICES.map((c) => (
                      <button key={c} type="button"
                        className={'chip sm' + ((s.services || []).includes(c) ? ' active' : '')}
                        onClick={() => updateSite(s.id, { services: (s.services || []).includes(c) ? (s.services || []).filter((x) => x !== c) : [...(s.services || []), c] })}>
                        {c}
                      </button>
                    ))}
                  </div>
                </Field>
              </div>
            </div>
          ))}
          <button type="button" className="btn-add" onClick={addSite}>+ Add Site</button>
        </Card>

        <Card title="3 · Agreements">
          {agreements.map((a) => (
            <div className="mc-site-card" key={a.id}>
              <div className="subsection-head">
                <span className="mono-label">Agreement</span>
                <button type="button" className="btn-x" onClick={() => removeAgreement(a.id)}>×</button>
              </div>
              <div className="grid-2">
                <Field label="Agreement name"><TextInput value={a.name} onChange={(v) => updateAgreement(a.id, { name: v })} placeholder="Site — Monitoring Agreement" /></Field>
                <Field label="Term (months)">
                  <select value={a.termMonths} onChange={(e) => updateAgreement(a.id, { termMonths: Number(e.target.value) })}>
                    <option value={12}>12</option><option value={24}>24</option>
                    <option value={36}>36</option><option value={60}>60</option>
                  </select>
                </Field>
              </div>
              <Field label="Covered sites">
                <div className="chip-row">
                  {sites.map((s, i) => (
                    <button key={s.id} type="button"
                      className={'chip sm' + (a.siteIds.includes(s.id) ? ' active' : '')}
                      onClick={() => toggleAgreementSite(a, s.id)}>
                      Site {i + 1}{s.city ? ` · ${s.city}` : ''}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Notes"><TextInput value={a.notes} onChange={(v) => updateAgreement(a.id, { notes: v })} placeholder="Special terms…" /></Field>
            </div>
          ))}
          <button type="button" className="btn-add" onClick={addAgreement}>+ Add Agreement</button>
        </Card>
      </div>

      <div className="qb-right">
        <Card title="Contract Summary">
          <div className="quote-summary" style={{ marginTop: 0 }}>
            <div className="quote-summary-title">Monitoring RMR</div>
            <div className="qs-rmr">{monthlyTotal > 0 ? money(monthlyTotal) + '/mo' : '—'}</div>
            <div className="qs-sub">{sites.length} site{sites.length === 1 ? '' : 's'} · {agreements.length} agreement{agreements.length === 1 ? '' : 's'}</div>
            {sites.map((s, i) => (
              <div className="metric-row" key={s.id}>
                <span className="metric-label">Site {i + 1}{s.city ? ` · ${s.city}` : ''}</span>
                <span className="metric-value">{num(s.monthlyRate) > 0 ? money(num(s.monthlyRate)) : '—'}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
