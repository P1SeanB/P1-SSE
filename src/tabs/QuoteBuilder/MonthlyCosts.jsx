import React from 'react';
import { Card, Field, TextInput, NumInput, SectionLabel, CheckRow, RateSelect } from '../../components/ui.jsx';
import { money, num } from '../../lib/format.js';

// The recurring half of a quote — legacy COST_IDS (:3491) and the monthly costs panel.
//
// Every figure comes from useMonthlyCosts, which owns the state and the arithmetic.
// This file decides what is visible.
//
// The Alarm.com PACKAGE is not here: it is 68 controls across nine sections and gets
// its own card (AdcPanel), rendered by the tab. What is here is the line that switches
// it on and shows what it costs.

export default function MonthlyCosts({ m, rates, systemType }) {
  const options = rates?.dropdownOptions || {};
  const g = rates?.gcs || {};

  return (
    <Card title="Monthly costs">
      <SectionLabel>Monitoring / platform</SectionLabel>
      <div className="cost-row">
        <span className="cost-name">GCS monitoring <span className="hint">auto</span></span>
        <span className="cost-amt">{money(m.gcs)}</span>
      </div>
      {systemType === 'Other/All Services' && (
        <div className="gcs-other">
          <CheckRow label="GCS Commercial Fire Monitoring" checked={m.gcsChecks.fire}
            onChange={(c) => m.setGcsChecks((s) => ({ ...s, fire: c }))} amount={Number(g.FireRate) || 0} />
          <CheckRow label="GCS Commercial Burg Monitoring" checked={m.gcsChecks.burg}
            onChange={(c) => m.setGcsChecks((s) => ({ ...s, burg: c }))} amount={Number(g.BurgRate) || 0} />
          <CheckRow label="GCS Residential Burg Monitoring" checked={m.gcsChecks.res}
            onChange={(c) => m.setGcsChecks((s) => ({ ...s, res: c }))} amount={Number(g.ResidentialRate) || 0} />
        </div>
      )}

      <div className="cost-row">
        <label className="cost-name check">
          <input type="checkbox" checked={m.adcEnabled} onChange={(e) => m.setAdcEnabled(e.target.checked)} />
          Alarm.com
        </label>
        <span className="cost-amt">{money(m.adcTotal)}</span>
      </div>

      {/* ConnectOne is hidden while Alarm.com is on — legacy :3747-3751. The two are
          alternative platforms, and a quote carrying both is a mistake, not a choice. */}
      {!m.adcEnabled && (
        <>
          <div className="cost-row">
            <label className="cost-name check">
              <input type="checkbox" checked={m.connectOne.enabled}
                onChange={(e) => m.setConnectOne((c) => ({ ...c, enabled: e.target.checked }))} />
              ConnectOne
            </label>
            <span className="cost-amt">{money(m.connectOneTotal)}</span>
          </div>
          {m.connectOne.enabled && (
            <div className="builder-panel">
              <div className="builder-title">ConnectOne Package Builder</div>
              <Field label={`ESSENTIAL+ base (${money(Number(rates?.monitoring?.BaseRate) || 0)}/system/mo) — number of systems`}>
                <NumInput value={m.connectOne.systems}
                  onChange={(v) => m.setConnectOne((c) => ({ ...c, systems: v }))} min="1" step="1" />
              </Field>
              <CheckRow label="Non-Alarm Zone Status Logging" checked={m.connectOne.addon}
                onChange={(c) => m.setConnectOne((s) => ({ ...s, addon: c }))}
                amount={(Number(rates?.monitoring?.AddonRate) || 0) * Math.max(1, num(m.connectOne.systems) || 1)} />
              <Field label="SMS Messages">
                <RateSelect group="connectone-sms" options={options} value={m.connectOne.sms}
                  onChange={(v) => m.setConnectOne((c) => ({ ...c, sms: v }))} />
              </Field>
              <div className="builder-total"><span>Total ConnectOne Monthly</span><span>{money(m.connectOneTotal)}</span></div>
            </div>
          )}
        </>
      )}

      <div className="cost-row">
        <label className="cost-name check">
          <input type="checkbox" checked={m.alarmNet.enabled}
            onChange={(e) => m.setAlarmNet((a) => ({ ...a, enabled: e.target.checked }))} />
          AlarmNet / TC2
        </label>
        <span className="cost-amt">{money(m.alarmNetTotal)}</span>
      </div>
      {m.alarmNet.enabled && (
        <div className="builder-panel">
          <Field label="AlarmNet / TC2 Plan">
            <RateSelect group="alarmnet-plan" options={options} value={m.alarmNet.plan}
              onChange={(v) => m.setAlarmNet((a) => ({ ...a, plan: v }))} />
          </Field>
        </div>
      )}

      <div className="cost-row">
        <span className="cost-name">Access hosting</span>
        <NumInput value={m.accessHosting} onChange={m.setAccessHosting} step="0.01" style={{ width: 90 }} />
      </div>
      <div className="cost-row">
        <TextInput value={m.customMon.desc} onChange={(v) => m.setCustomMon((c) => ({ ...c, desc: v }))}
          placeholder="Other monitoring / platform service…" style={{ flex: 1, marginRight: 8 }} />
        <NumInput value={m.customMon.cost} onChange={(v) => m.setCustomMon((c) => ({ ...c, cost: v }))}
          step="0.01" style={{ width: 90 }} />
      </div>

      <SectionLabel>Other monthly</SectionLabel>
      <CheckRow label="Honeywell Communicator" checked={m.checks.honeywell}
        onChange={(c) => m.setChecks((s) => ({ ...s, honeywell: c }))} amount={m.rate.honeywell} />
      <CheckRow label="Telguard Communicator" checked={m.checks.teleguard}
        onChange={(c) => m.setChecks((s) => ({ ...s, teleguard: c }))} amount={m.rate.teleguard} />
      <CheckRow label="BuildingReports.com" checked={m.checks.br}
        onChange={(c) => m.setChecks((s) => ({ ...s, br: c }))} amount={m.rate.br} />
      {/* Only San Francisco charges a burglar-alarm permit, so the row appears only
          when the site is there — legacy behaviour, kept because a permanently visible
          $0 line invites someone to tick it. */}
      {m.isSF && (
        <CheckRow label="SF Burg permit" checked={m.checks.sfburg}
          onChange={(c) => m.setChecks((s) => ({ ...s, sfburg: c }))} amount={m.rate.sfburg} />
      )}
      <CheckRow label="UL certs" checked={m.checks.ulcerts}
        onChange={(c) => m.setChecks((s) => ({ ...s, ulcerts: c }))} amount={m.rate.ulcerts} />
      {!m.adcEnabled && (
        <div className="cb-row">
          <input type="checkbox" checked={m.checks.bosch}
            onChange={(e) => m.setChecks((s) => ({ ...s, bosch: e.target.checked }))} />
          <label className="cb-name">Bosch Cloud</label>
          {m.checks.bosch
            ? <NumInput value={m.boschAmt} onChange={m.setBoschAmt} step="0.01" style={{ width: 80 }} />
            : <span className="cb-value">$0.00</span>}
        </div>
      )}
    </Card>
  );
}
