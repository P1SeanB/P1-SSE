import React from 'react';
import { Card, Field, TextInput, NumInput, Slider, SectionLabel } from '../../components/ui.jsx';
import { money } from '../../lib/format.js';

// Estimate identity, billing address, and the one-time financial inputs that were
// not covered elsewhere — the tail of the legacy quote form.
//
// Grouped this way because they share a property: none of them change a monthly
// figure. They identify the estimate, say where the invoice goes, and feed the
// one-time total via src/lib/materials.js computeOneTimeTotal, which is
// parity-verified. Nothing here does arithmetic.

/** Billing address, with the "same as site" shortcut the legacy offers. */
function BillingAddress({ value, onChange, site }) {
  const set = (patch) => onChange({ ...value, ...patch });

  // Copying on toggle rather than binding through means the fields stay editable
  // afterwards. The legacy behaves the same way: ticking it fills them in, and
  // someone can still correct a suite number without untucking the box.
  const useSame = (on) => {
    if (!on) return set({ same: false });
    set({
      same: true,
      address: site.address || '', city: site.city || '',
      state: site.state || '', zip: site.zip || '',
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <label style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
        <input type="checkbox" checked={!!value.same} onChange={(e) => useSame(e.target.checked)} />
        <span>Billing address is the same as the site</span>
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 0.6fr 0.8fr', gap: '0.5rem' }}>
        <Field label="Address"><TextInput value={value.address} onChange={(v) => set({ address: v, same: false })} /></Field>
        <Field label="City"><TextInput value={value.city} onChange={(v) => set({ city: v, same: false })} /></Field>
        <Field label="State"><TextInput value={value.state} onChange={(v) => set({ state: v.toUpperCase().slice(0, 2), same: false })} maxLength={2} /></Field>
        <Field label="ZIP"><TextInput value={value.zip} onChange={(v) => set({ zip: v, same: false })} /></Field>
      </div>
    </div>
  );
}

export default function EstimateDetails({ value, onChange, site = {}, oneTime }) {
  const set = (patch) => onChange({ ...value, ...patch });

  return (
    <Card title="Estimate Details">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
        <div>
          <SectionLabel>Identity</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(11rem,1fr))', gap: '0.5rem' }}>
            <Field label="Estimate # / service ticket #">
              <TextInput value={value.estimateNumber} onChange={(v) => set({ estimateNumber: v })} />
            </Field>
            <Field label="Estimate or agreement name">
              <TextInput value={value.agreementName} onChange={(v) => set({ agreementName: v })} />
            </Field>
            <Field label="Estimator name">
              <TextInput value={value.estimatorName} onChange={(v) => set({ estimatorName: v })} />
            </Field>
            <Field label="Estimator email">
              <TextInput value={value.estimatorEmail} onChange={(v) => set({ estimatorEmail: v })} type="email" />
            </Field>
          </div>
        </div>

        <div>
          <SectionLabel>Billing address</SectionLabel>
          <BillingAddress value={value.billing} site={site}
            onChange={(billing) => set({ billing })} />
        </div>

        <div>
          <SectionLabel>Annual costs</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(11rem,1fr))', gap: '0.5rem' }}>
            {/* A/V maintenance is billed at its own gross margin rather than the
                service GM — see calc.js:4280-4283 — which is why it is entered
                separately instead of folded into monitoring costs. */}
            <Field label="A/V maintenance ($/yr, cost)">
              <NumInput value={value.avMaintenance} onChange={(v) => set({ avMaintenance: v })} step="0.01" />
            </Field>
            <Field label="Annual subcontractor cost">
              <NumInput value={value.annualSub} onChange={(v) => set({ annualSub: v })} step="0.01" />
            </Field>
          </div>
        </div>

        <div>
          <SectionLabel>One-time charges</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(11rem,1fr))', gap: '0.5rem' }}>
            <Field label="Shipping cost">
              <NumInput value={value.shippingCost} onChange={(v) => set({ shippingCost: v })} step="0.01" />
            </Field>
            {/* Shipping carries its OWN markup, independent of the material markup.
                Slider renders its own label, so it is not wrapped in a Field. */}
            <Slider label="Shipping markup" value={value.shippingMarkup}
              min={0} max={100} step={1}
              onChange={(v) => set({ shippingMarkup: v })}
              format={(v) => `${v}%`} />
            {/* Sales tax is a pass-through and applies to MATERIALS ONLY — not to
                labour, the subcontract, or shipping. */}
            <Field label="Material sales tax">
              <NumInput value={value.materialTaxRate} onChange={(v) => set({ materialTaxRate: v })}
                step="0.001" min="0" max="20" />
            </Field>
          </div>
        </div>

        {oneTime && oneTime.total > 0 && (
          <div style={{ borderTop: '1px solid var(--border, #d8dbe0)', paddingTop: '0.6rem', fontSize: '0.9rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Materials</span><span>{money(oneTime.materialsBilled)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Labor</span><span>{money(oneTime.laborBilled)}</span>
            </div>
            {oneTime.subBilled > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Subcontract</span><span>{money(oneTime.subBilled)}</span>
              </div>
            )}
            {oneTime.materialTax > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Material tax</span><span>{money(oneTime.materialTax)}</span>
              </div>
            )}
            {oneTime.shippingBilled > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Shipping</span><span>{money(oneTime.shippingBilled)}</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, marginTop: '0.3rem' }}>
              <span>One-time total</span><span>{money(oneTime.total)}</span>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

export const newEstimateDetails = () => ({
  estimateNumber: '', agreementName: '', estimatorName: '', estimatorEmail: '',
  billing: { same: false, address: '', city: '', state: '', zip: '' },
  avMaintenance: '', annualSub: '',
  shippingCost: '', shippingMarkup: 15, materialTaxRate: '',
});
