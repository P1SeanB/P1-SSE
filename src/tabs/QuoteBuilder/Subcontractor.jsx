import React from 'react';
import { Card, Field, NumInput, SectionLabel } from '../../components/ui.jsx';
import { money } from '../../lib/format.js';

// Subcontracted work — the legacy's sub-type panel (index.html, selectSubType) plus
// the annual subcontractor cost.
//
// The annual cost feeds computeQuote as `annualSub`, where it is marked up by
// subMarkup and spread across the monthly figure — that arithmetic is in calc.js and
// parity-verified. This component only collects it.
//
// The TYPE is not priced. It exists because "subcontractor — $4,800/yr" on a
// proposal invites the question the type answers, and because a sprinkler
// subcontract and a locksmith subcontract are inspected under different codes.

const SUB_TYPES = ['Sprinkler', 'Locksmith', 'Other'];

export default function Subcontractor({ value, onChange, subMarkup = 0.15 }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const annual = Number(value.annualCost) || 0;
  // Shown, not computed here — the same markup calc.js applies, surfaced so the
  // estimator can see what the customer will be charged before it reaches a summary.
  const billed = annual * (1 + subMarkup);

  return (
    <Card title="Subcontracted Work">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
        <div>
          <SectionLabel>Type</SectionLabel>
          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
            {SUB_TYPES.map((t) => (
              <button key={t} type="button"
                onClick={() => set({ type: value.type === t ? '' : t })}
                aria-pressed={value.type === t}
                style={{ fontWeight: value.type === t ? 700 : 400 }}>
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Only 'Other' needs describing — the named types already say what they are,
            and asking for a description of "Sprinkler" produces "sprinkler". */}
        {value.type === 'Other' && (
          <Field label="Describe the subcontracted work">
            <textarea value={value.description}
              onChange={(e) => set({ description: e.target.value })}
              rows={2} style={{ width: '100%' }}
              placeholder="e.g. Annual elevator inspection and maintenance by certified vendor" />
          </Field>
        )}

        <Field label="Annual subcontractor cost">
          <NumInput value={value.annualCost} onChange={(v) => set({ annualCost: v })} step="0.01" />
        </Field>

        {annual > 0 && (
          <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-muted, #6b7688)' }}>
            Billed at {money(billed)}/yr with the {Math.round(subMarkup * 100)}% subcontractor
            markup — {money(billed / 12)}/mo of the recurring figure.
          </p>
        )}
      </div>
    </Card>
  );
}

export const newSubcontractor = () => ({ type: '', description: '', annualCost: '' });
