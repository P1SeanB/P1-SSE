import React from 'react';
import { Card, Field, TextInput, SectionLabel } from '../../components/ui.jsx';
import {
  SLA_OPS_OPTIONS, allowsCustom, meetingCoverageIncluded,
} from '../../lib/slaOps.js';

// Operational requirements for a service agreement — the legacy's slaops-* section
// (index.html:12780-12880).
//
// None of this is priced. It is the LANGUAGE of the agreement: who sets a meeting
// up, how fast someone answers remotely, what happens to spares, how often the
// inventory is audited. It prints on a document a customer signs, which is why the
// wording lives in src/lib/slaOps.js as data rather than being retyped here.

/**
 * A select whose 'Custom' choice reveals a free-text field.
 *
 * 'Custom' is not just another value — it means the printed clause is written by
 * hand for this customer. Offering it without somewhere to write the clause produces
 * an agreement that says "Custom" and nothing else, which is worse than not offering
 * it at all.
 */
function OpsSelect({ label, optionKey, value, customValue, onChange, onCustomChange }) {
  const options = SLA_OPS_OPTIONS[optionKey] || [];
  const showCustom = allowsCustom(optionKey) && value === 'Custom';
  return (
    <>
      <Field label={label}>
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">— Select —</option>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </Field>
      {showCustom && (
        <Field label={`${label} — describe`}>
          <TextInput value={customValue} onChange={onCustomChange}
            placeholder="This wording prints on the agreement" />
        </Field>
      )}
    </>
  );
}

function CheckList({ label, optionKey, values, onChange }) {
  const options = SLA_OPS_OPTIONS[optionKey] || [];
  const toggle = (o) =>
    onChange(values.includes(o) ? values.filter((v) => v !== o) : [...values, o]);
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
        {options.map((o) => (
          <label key={o} style={{ display: 'flex', gap: '0.4rem', alignItems: 'flex-start' }}>
            <input type="checkbox" checked={values.includes(o)} onChange={() => toggle(o)} />
            <span style={{ fontSize: '0.9rem' }}>{o}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export default function SlaOperations({ value: ops, onChange }) {
  const set = (patch) => onChange({ ...ops, ...patch });
  const meetings = meetingCoverageIncluded(ops.meetingInclude);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <Card title="Operational Requirements">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(13rem,1fr))', gap: '0.6rem' }}>
          <OpsSelect label="Industry" optionKey="industry"
            value={ops.industry} onChange={(v) => set({ industry: v })} />
          <OpsSelect label="Criticality" optionKey="criticality"
            value={ops.criticality} customValue={ops.criticalityCustom}
            onChange={(v) => set({ criticality: v })}
            onCustomChange={(v) => set({ criticalityCustom: v })} />
        </div>
        <div style={{ marginTop: '0.6rem' }}>
          <Field label="Preventive maintenance objective">
            <textarea value={ops.pmObjective} onChange={(e) => set({ pmObjective: e.target.value })}
              rows={3} style={{ width: '100%' }}
              placeholder="What this agreement is meant to achieve for the customer" />
          </Field>
        </div>
      </Card>

      <Card title="Meeting Support">
        <OpsSelect label="Meeting support included" optionKey="meetingInclude"
          value={ops.meetingInclude} onChange={(v) => set({ meetingInclude: v })} />

        {/* The rest applies only once coverage is included at all. Asking for a
            remote response time on an agreement with no meeting coverage produces
            an answer that then prints on the document. */}
        {!meetings && (
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: 'var(--text-muted, #6b7688)' }}>
            No meeting coverage on this agreement. Choose a coverage type to set response
            times, scheduling and remote access.
          </p>
        )}

        {meetings && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(13rem,1fr))', gap: '0.6rem', marginTop: '0.6rem' }}>
            <OpsSelect label="Schedule source" optionKey="scheduleSource"
              value={ops.scheduleSource} onChange={(v) => set({ scheduleSource: v })} />
            <OpsSelect label="Frequency" optionKey="frequency"
              value={ops.frequency} customValue={ops.frequencyCustom}
              onChange={(v) => set({ frequency: v })}
              onCustomChange={(v) => set({ frequencyCustom: v })} />
            <OpsSelect label="Duration" optionKey="duration"
              value={ops.duration} customValue={ops.durationCustom}
              onChange={(v) => set({ duration: v })}
              onCustomChange={(v) => set({ durationCustom: v })} />
            <OpsSelect label="Support window" optionKey="supportWindow"
              value={ops.supportWindow} customValue={ops.supportWindowCustom}
              onChange={(v) => set({ supportWindow: v })}
              onCustomChange={(v) => set({ supportWindowCustom: v })} />
            <OpsSelect label="Remote response" optionKey="remoteResp"
              value={ops.remoteResp} customValue={ops.remoteRespCustom}
              onChange={(v) => set({ remoteResp: v })}
              onCustomChange={(v) => set({ remoteRespCustom: v })} />
            <OpsSelect label="Onsite dispatch" optionKey="onsiteDispatch"
              value={ops.onsiteDispatch} customValue={ops.onsiteDispatchCustom}
              onChange={(v) => set({ onsiteDispatch: v })}
              onCustomChange={(v) => set({ onsiteDispatchCustom: v })} />
            <OpsSelect label="Remote hands available" optionKey="remoteHands"
              value={ops.remoteHands} onChange={(v) => set({ remoteHands: v })} />
          </div>
        )}

        {meetings && (
          <div style={{ marginTop: '0.6rem' }}>
            <CheckList label="Remote access method" optionKey="remoteMethod"
              values={ops.remoteMethod} onChange={(v) => set({ remoteMethod: v })} />
          </div>
        )}
      </Card>

      <Card title="Workflow">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(13rem,1fr))', gap: '0.6rem' }}>
          <OpsSelect label="Room set up by" optionKey="setupBy"
            value={ops.setupBy} onChange={(v) => set({ setupBy: v })} />
          <OpsSelect label="Pre-meeting check by" optionKey="checkBy"
            value={ops.checkBy} onChange={(v) => set({ checkBy: v })} />
          <OpsSelect label="Point 1 role" optionKey="p1Role"
            value={ops.p1Role} customValue={ops.p1RoleCustom}
            onChange={(v) => set({ p1Role: v })}
            onCustomChange={(v) => set({ p1RoleCustom: v })} />
        </div>
      </Card>

      <Card title="Materials &amp; Spares">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(13rem,1fr))', gap: '0.6rem' }}>
          <OpsSelect label="Material strategy" optionKey="materialStrategy"
            value={ops.materialStrategy} onChange={(v) => set({ materialStrategy: v })} />
          <OpsSelect label="Inventory audit frequency" optionKey="auditFreq"
            value={ops.auditFreq} customValue={ops.auditFreqCustom}
            onChange={(v) => set({ auditFreq: v })}
            onCustomChange={(v) => set({ auditFreqCustom: v })} />
        </div>
      </Card>
    </div>
  );
}
