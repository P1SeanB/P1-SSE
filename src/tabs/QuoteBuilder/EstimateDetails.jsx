import React from 'react';
import { Card, Field, TextInput, NumInput, Slider, SectionLabel } from '../../components/ui.jsx';

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

export default function EstimateDetails({ value, onChange, site = {} }) {
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

        {/* NO "ANNUAL COSTS" SECTION, deliberately — it was here and has been removed.
            Both fields it held are recurring, which contradicts this card's one rule,
            and both already have a home that owns them:

              annualSub      a visible input in the legacy (:2202), and in QuoteBuilder
                             it sits beside the subcontractor TYPE it classifies.
              avMaintenance  a HIDDEN field in the legacy (:2234), written by summing
                             the A/V part rows (:5677-5680). It is a total, not an
                             entry. QuoteBuilder's parts list is that sum.

            Rendering either here would give one number two inputs, and the second one
            an estimator fills in is the one that gets double-counted. */}

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

      </div>
    </Card>
  );
}

export { newEstimateDetails } from './estimateState.js';
