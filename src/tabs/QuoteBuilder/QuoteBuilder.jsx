import React, { useMemo, useState } from 'react';
import { useAppState, lookupZip } from '../../store/AppState.jsx';
import { computeQuote, calcFireInspection, calcPmInspection, TM_TYPES } from '../../lib/calc.js';
import { money, pct, num } from '../../lib/format.js';
import {
  Card, Field, TextInput, NumInput, Slider, MetricRow, BigMetric,
  SectionLabel, CheckRow, RateSelect, optionPrice,
} from '../../components/ui.jsx';
import {
  FIRE_DEVICES, PM_STANDARD_DEVICES, PM_AV_DEVICES, ESTIMATE_TYPES, blankDeviceState,
} from './deviceRows.js';

// GM gross-profit color bands — legacy/index.html:4456-4459
function gpColor(gm) {
  if (gm == null) return 'var(--text)';
  if (gm >= 0.53) return '#1a6b4a';
  if (gm >= 0.45) return '#d97706';
  if (gm >= 0.35) return '#e05c20';
  return '#dc2626';
}

export default function QuoteBuilder({ rates }) {
  const { customer, updateCustomer, sites, updateSite, addSite, removeSite, quotedMonthlyTotal } = useAppState();
  const labor = rates?.labor || {};
  const misc = rates?.misc || {};
  const options = rates?.dropdownOptions || {};

  // ── Estimate meta ─────────────────────────────────────────────────────────
  const [systemType, setSystemType] = useState('');
  const [siteType, setSiteType] = useState('');
  const [agreementName, setAgreementName] = useState('');
  const [estimator, setEstimator] = useState({ name: '', email: '', num: '' });
  const [notes, setNotes] = useState('');

  // ── Monthly monitoring / platform costs (legacy COST_IDS, :3491) ─────────
  const [gcsChecks, setGcsChecks] = useState({ fire: false, burg: false, res: false });
  const [adc, setAdc] = useState({ enabled: false, base: '', video: '', cameraCount: 1, comms: '', sensors: '', extras: '' });
  const [connectOne, setConnectOne] = useState({ enabled: false, systems: 1, addon: false, sms: '' });
  const [alarmNet, setAlarmNet] = useState({ enabled: false, plan: '' });
  const [accessHosting, setAccessHosting] = useState('');
  const [checks, setChecks] = useState({ honeywell: false, teleguard: false, br: false, sfburg: false, ulcerts: false, bosch: false });
  const [boschAmt, setBoschAmt] = useState('');
  const [customMon, setCustomMon] = useState({ desc: '', cost: '' });

  // ── Labor / inspection ────────────────────────────────────────────────────
  const [fire, setFire] = useState(() => ({ rows: blankDeviceState(FIRE_DEVICES), pmHrs: '', techs: 1 }));
  const [pm, setPm] = useState(() => ({ rows: blankDeviceState([...PM_STANDARD_DEVICES, ...PM_AV_DEVICES], true), extraHrs: '', techs: 1 }));
  const [simpleInspHours, setSimpleInspHours] = useState('');
  const [annualSub, setAnnualSub] = useState('');
  const [subType, setSubType] = useState('');
  const [avParts, setAvParts] = useState([]); // {desc, unitCost, qty}

  // ── Margin sliders (defaults from the rate profile, legacy :3424-3432) ───
  const [svcGM, setSvcGM] = useState(null);
  const [subMarkup, setSubMarkup] = useState(null);
  const [avMaintGM, setAvMaintGM] = useState(null);
  const [laborRate, setLaborRate] = useState(null);
  const [overheadRate, setOverheadRate] = useState(null);
  const [ohMethod, setOhMethod] = useState('revenue');

  const svcGMv = svcGM ?? (Number(labor.SvcGM) || 53);
  const subMarkupv = subMarkup ?? (Number(labor.SubMarkup) || 25);
  const avMaintGMv = avMaintGM ?? (Number(labor.AvMaintGM) || 45);
  const laborRatev = laborRate ?? (Number(labor.LaborBillDefault) || 100);
  const overheadRatev = overheadRate ?? (Number(labor.OverheadRate) || 0.1);

  const isTM = TM_TYPES.includes(systemType);
  const isFireType = systemType === 'Fire Monitoring & Services';
  const isAvType = systemType === 'A/V PM Services';
  const isCommercial = siteType === 'Commercial';
  const site1 = sites[0];

  // GCS auto rate by system/site type — legacy :7318-7320, :7408-7411
  const gcs = useMemo(() => {
    const g = rates?.gcs || {};
    if (systemType === 'Fire Monitoring & Services') return Number(g.FireRate) || 0;
    if (systemType === 'Burglar Monitoring & Services')
      return isCommercial ? Number(g.BurgRate) || 0 : Number(g.ResidentialRate) || 0;
    if (systemType === 'Two-Way Monitoring & Services') return Number(g.TwoWayRate) || 0;
    if (systemType === 'Other/All Services') {
      return (gcsChecks.fire ? Number(g.FireRate) || 0 : 0)
        + (gcsChecks.burg ? Number(g.BurgRate) || 0 : 0)
        + (gcsChecks.res ? Number(g.ResidentialRate) || 0 : 0);
    }
    return 0;
  }, [rates, systemType, isCommercial, gcsChecks]);

  // ConnectOne — legacy :3692-3699
  const connectOneTotal = useMemo(() => {
    if (!connectOne.enabled) return 0;
    const systems = Math.max(1, num(connectOne.systems) || 1);
    const base = (Number(rates?.monitoring?.BaseRate) || 0) * systems;
    const addon = connectOne.addon ? (Number(rates?.monitoring?.AddonRate) || 0) * systems : 0;
    const sms = optionPrice(options, 'connectone-sms', connectOne.sms);
    return base + addon + sms;
  }, [connectOne, rates, options]);

  // Alarm.com builder (base + selected add-on menus)
  const adcTotal = useMemo(() => {
    if (!adc.enabled) return 0;
    return optionPrice(options, 'adc-base', adc.base)
      + optionPrice(options, 'adc-video', adc.video) * Math.max(1, num(adc.cameraCount) || 1)
      + optionPrice(options, 'adc-comms', adc.comms)
      + optionPrice(options, 'adc-sensors', adc.sensors)
      + (num(adc.extras) || 0);
  }, [adc, options]);

  const alarmNetTotal = alarmNet.enabled ? optionPrice(options, 'alarmnet-plan', alarmNet.plan) : 0;
  const sfBurgRate = isCommercial ? Number(rates?.gcs?.SfBurgCommercial) || 0 : Number(rates?.gcs?.SfBurgResidential) || 0;
  const isSF = /san francisco/i.test(site1?.city || '');

  // Fixed "Other monthly" rates come from the rate profile (MiscRate keys) —
  // in the legacy file these were hardcoded in the HTML onchange handlers (:1861-1863).
  // These now come from misc_rate like every other price. They used to fall back to
  // 13/25/6 hardcoded here, mirroring the legacy's markup — correct until the day a
  // price moved, at which point it needed a deploy.
  const honeywellRate = Number(misc.honeywellComm) || 0;
  const teleguardRate = Number(misc.telguardComm) || 0;
  const brRate = Number(misc.buildingReports) || 0;
  const ulCertsRate = Number(misc.ulCerts) || 0;

  const monthlyCosts =
    gcs + adcTotal + connectOneTotal + alarmNetTotal + num(accessHosting)
    + (checks.honeywell ? honeywellRate : 0)
    + (checks.teleguard ? teleguardRate : 0)
    + (checks.br ? brRate : 0)
    + (checks.sfburg ? sfBurgRate : 0)
    + (checks.ulcerts ? ulCertsRate : 0)
    + (checks.bosch ? num(boschAmt) : 0)
    + num(customMon.cost);

  // Inspection hours: fire calculator, PM calculator, or simple entry
  const fireCalc = useMemo(() => calcFireInspection(
    FIRE_DEVICES.map((d) => ({ ...fire.rows[d.key], semi: d.semi })),
    fire.pmHrs, fire.techs, Number(labor.LaborCostPerHr) || 0, laborRatev,
  ), [fire, labor, laborRatev]);

  const pmDevices = isAvType ? PM_AV_DEVICES : PM_STANDARD_DEVICES;
  const pmCalc = useMemo(() => calcPmInspection(
    pmDevices.map((d) => pm.rows[d.key]),
    pm.extraHrs, pm.techs, Number(labor.LaborCostPerHr) || 0, laborRatev,
  ), [pm, pmDevices, labor, laborRatev]);

  const inspHours = isFireType ? fireCalc.totalHrs
    : (isAvType || systemType === 'Burglar Monitoring & Services') && pmCalc.totalHrs > 0 ? pmCalc.totalHrs
    : num(simpleInspHours);

  const avMaintTotal = avParts.reduce((s, p) => s + num(p.unitCost) * (num(p.qty) || 1), 0);

  const q = useMemo(() => computeQuote({
    systemType, siteType,
    monthlyCosts,
    inspHours,
    annualSub: num(annualSub),
    avMaint: avMaintTotal,
    svcGM: svcGMv / 100,
    subMarkup: subMarkupv / 100,
    avMaintGM: avMaintGMv / 100,
    laborRate: laborRatev,
    overheadRate: Number(overheadRatev),
    ohMethod,
    quotedMonthly: quotedMonthlyTotal,
  }, rates), [systemType, siteType, monthlyCosts, inspHours, annualSub, avMaintTotal,
    svcGMv, subMarkupv, avMaintGMv, laborRatev, overheadRatev, ohMethod, quotedMonthlyTotal, rates]);

  const setFireRow = (key, patch) => setFire((f) => ({ ...f, rows: { ...f.rows, [key]: { ...f.rows[key], ...patch } } }));
  const setPmRow = (key, patch) => setPm((p) => ({ ...p, rows: { ...p.rows, [key]: { ...p.rows[key], ...patch } } }));

  async function onZipBlur(zip) {
    const found = await lookupZip(zip);
    if (found) updateSite(site1.id, { city: found.city, state: found.state });
  }

  return (
    <div className="qb-layout">
      <div className="qb-left">
        {/* ── Customer info ── */}
        <Card title="Customer info">
          <div className="grid-2">
            <Field label="Company name"><TextInput value={customer.companyName} onChange={(v) => updateCustomer({ companyName: v })} placeholder="e.g. Acme Corp" /></Field>
            <Field label="Customer name (First and Last)"><TextInput value={customer.contactName} onChange={(v) => updateCustomer({ contactName: v })} placeholder="First Last" /></Field>
          </div>
          <Field label="Site address"><TextInput value={site1.address} onChange={(v) => updateSite(site1.id, { address: v })} placeholder="123 Main St" /></Field>
          <div className="grid-3">
            <Field label="City"><TextInput value={site1.city} onChange={(v) => updateSite(site1.id, { city: v })} /></Field>
            <Field label="State"><TextInput value={site1.state} onChange={(v) => updateSite(site1.id, { state: v.toUpperCase() })} maxLength={2} /></Field>
            <Field label="ZIP"><TextInput value={site1.zip} onChange={(v) => updateSite(site1.id, { zip: v })} onBlur={(e) => onZipBlur(e.target.value)} maxLength={10} /></Field>
          </div>
          <div className="grid-2">
            <Field label="Phone number"><TextInput value={customer.phone} onChange={(v) => updateCustomer({ phone: v })} placeholder="(555) 555-5555" /></Field>
            <Field label="Email"><TextInput value={customer.email} onChange={(v) => updateCustomer({ email: v })} placeholder="contact@example.com" /></Field>
          </div>
          <div className="grid-3">
            <Field label="Estimate type">
              <select value={systemType} onChange={(e) => setSystemType(e.target.value)}>
                <option value="" disabled>— Select One —</option>
                {ESTIMATE_TYPES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Site type">
              <select value={siteType} onChange={(e) => setSiteType(e.target.value)}>
                <option value="" disabled>— Select One —</option>
                <option>Commercial</option>
                <option>Residential</option>
              </select>
            </Field>
            <Field label="Estimate or Agreement Name"><TextInput value={agreementName} onChange={setAgreementName} placeholder="Site — Service or Estimate Name" /></Field>
          </div>
          <div className="grid-3">
            <Field label="Estimator name"><TextInput value={estimator.name} onChange={(v) => setEstimator((s) => ({ ...s, name: v }))} placeholder="Full name" /></Field>
            <Field label="Estimator email"><TextInput value={estimator.email} onChange={(v) => setEstimator((s) => ({ ...s, email: v }))} placeholder="name@point1.com" /></Field>
            <Field label="Estimate# or Service Ticket#"><TextInput value={estimator.num} onChange={(v) => setEstimator((s) => ({ ...s, num: v }))} placeholder="e.g. EST-2026-001" /></Field>
          </div>

          {/* Sites — shared with Monitoring Contracts */}
          <div className="subsection">
            <div className="subsection-head">
              <span className="mono-label">Sites</span>
              <span className="sync-chip">LIVE-SYNCED WITH MONITORING CONTRACTS</span>
            </div>
            <div className="grid-2">
              <Field label="Site 1 Monthly Rate ($)"><NumInput value={site1.monthlyRate} onChange={(v) => updateSite(site1.id, { monthlyRate: v })} step="0.01" /></Field>
            </div>
            {sites.slice(1).map((s, i) => (
              <div className="site-row" key={s.id}>
                <TextInput value={s.address} onChange={(v) => updateSite(s.id, { address: v })} placeholder={`Site ${i + 2} address`} />
                <TextInput value={s.city} onChange={(v) => updateSite(s.id, { city: v })} placeholder="City" />
                <NumInput value={s.monthlyRate} onChange={(v) => updateSite(s.id, { monthlyRate: v })} step="0.01" placeholder="$/mo" />
                <button type="button" className="btn-x" onClick={() => removeSite(s.id)}>×</button>
              </div>
            ))}
            <button type="button" className="btn-add" onClick={addSite}>+ Add Site</button>
          </div>
        </Card>

        {/* ── Notes ── */}
        <Card title="Notes">
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Scope notes, special terms, follow-up items…" style={{ width: '100%' }} />
        </Card>

        {/* ── Monthly costs ── */}
        {systemType && !isTM && (
          <Card title="Monthly costs">
            <SectionLabel>Monitoring / platform</SectionLabel>
            <div className="cost-row">
              <span className="cost-name">GCS monitoring <span className="hint">auto</span></span>
              <span className="cost-amt">{money(gcs)}</span>
            </div>
            {systemType === 'Other/All Services' && (
              <div className="gcs-other">
                <CheckRow label="GCS Commercial Fire Monitoring" checked={gcsChecks.fire} onChange={(c) => setGcsChecks((g) => ({ ...g, fire: c }))} amount={Number(rates?.gcs?.FireRate) || 0} />
                <CheckRow label="GCS Commercial Burg Monitoring" checked={gcsChecks.burg} onChange={(c) => setGcsChecks((g) => ({ ...g, burg: c }))} amount={Number(rates?.gcs?.BurgRate) || 0} />
                <CheckRow label="GCS Residential Burg Monitoring" checked={gcsChecks.res} onChange={(c) => setGcsChecks((g) => ({ ...g, res: c }))} amount={Number(rates?.gcs?.ResidentialRate) || 0} />
              </div>
            )}

            {/* Alarm.com */}
            <div className="cost-row">
              <label className="cost-name check">
                <input type="checkbox" checked={adc.enabled} onChange={(e) => setAdc((a) => ({ ...a, enabled: e.target.checked }))} />
                Alarm.com
              </label>
              <span className="cost-amt">{money(adcTotal)}</span>
            </div>
            {adc.enabled && (
              <div className="builder-panel">
                <div className="builder-title">Alarm.com Package Builder</div>
                <Field label="Base Package"><RateSelect group="adc-base" options={options} value={adc.base} onChange={(v) => setAdc((a) => ({ ...a, base: v }))} /></Field>
                {adc.base && (
                  <>
                    <Field label="Video Monitoring"><RateSelect group="adc-video" options={options} value={adc.video} onChange={(v) => setAdc((a) => ({ ...a, video: v }))} /></Field>
                    {adc.video && (
                      <Field label="Number of cameras"><NumInput value={adc.cameraCount} onChange={(v) => setAdc((a) => ({ ...a, cameraCount: v }))} min="1" step="1" /></Field>
                    )}
                    <Field label="Wireless Alarm Communications"><RateSelect group="adc-comms" options={options} value={adc.comms} onChange={(v) => setAdc((a) => ({ ...a, comms: v }))} /></Field>
                    <Field label="Additional Sensors"><RateSelect group="adc-sensors" options={options} value={adc.sensors} onChange={(v) => setAdc((a) => ({ ...a, sensors: v }))} /></Field>
                    <Field label="Other add-ons ($/mo) — energy, alerts, wellness, fleet">
                      <NumInput value={adc.extras} onChange={(v) => setAdc((a) => ({ ...a, extras: v }))} step="0.01" />
                    </Field>
                  </>
                )}
                <div className="builder-total"><span>Total Alarm.com Monthly</span><span>{money(adcTotal)}</span></div>
              </div>
            )}

            {/* ConnectOne — hidden while Alarm.com enabled (legacy :3747-3751) */}
            {!adc.enabled && (
              <>
                <div className="cost-row">
                  <label className="cost-name check">
                    <input type="checkbox" checked={connectOne.enabled} onChange={(e) => setConnectOne((c) => ({ ...c, enabled: e.target.checked }))} />
                    ConnectOne
                  </label>
                  <span className="cost-amt">{money(connectOneTotal)}</span>
                </div>
                {connectOne.enabled && (
                  <div className="builder-panel">
                    <div className="builder-title">ConnectOne Package Builder</div>
                    <Field label={`ESSENTIAL+ base (${money(Number(rates?.monitoring?.BaseRate) || 0)}/system/mo) — number of systems`}>
                      <NumInput value={connectOne.systems} onChange={(v) => setConnectOne((c) => ({ ...c, systems: v }))} min="1" step="1" />
                    </Field>
                    <CheckRow
                      label="Non-Alarm Zone Status Logging"
                      checked={connectOne.addon}
                      onChange={(c) => setConnectOne((s) => ({ ...s, addon: c }))}
                      amount={(Number(rates?.monitoring?.AddonRate) || 0) * Math.max(1, num(connectOne.systems) || 1)}
                    />
                    <Field label="SMS Messages"><RateSelect group="connectone-sms" options={options} value={connectOne.sms} onChange={(v) => setConnectOne((c) => ({ ...c, sms: v }))} /></Field>
                    <div className="builder-total"><span>Total ConnectOne Monthly</span><span>{money(connectOneTotal)}</span></div>
                  </div>
                )}
              </>
            )}

            {/* AlarmNet */}
            <div className="cost-row">
              <label className="cost-name check">
                <input type="checkbox" checked={alarmNet.enabled} onChange={(e) => setAlarmNet((a) => ({ ...a, enabled: e.target.checked }))} />
                AlarmNet / TC2
              </label>
              <span className="cost-amt">{money(alarmNetTotal)}</span>
            </div>
            {alarmNet.enabled && (
              <div className="builder-panel">
                <Field label="AlarmNet / TC2 Plan"><RateSelect group="alarmnet-plan" options={options} value={alarmNet.plan} onChange={(v) => setAlarmNet((a) => ({ ...a, plan: v }))} /></Field>
              </div>
            )}

            <div className="cost-row">
              <span className="cost-name">Access hosting</span>
              <NumInput value={accessHosting} onChange={setAccessHosting} step="0.01" style={{ width: 90 }} />
            </div>
            <div className="cost-row">
              <TextInput value={customMon.desc} onChange={(v) => setCustomMon((c) => ({ ...c, desc: v }))} placeholder="Other monitoring / platform service…" style={{ flex: 1, marginRight: 8 }} />
              <NumInput value={customMon.cost} onChange={(v) => setCustomMon((c) => ({ ...c, cost: v }))} step="0.01" style={{ width: 90 }} />
            </div>

            <SectionLabel>Other monthly</SectionLabel>
            <CheckRow label="Honeywell Communicator" checked={checks.honeywell} onChange={(c) => setChecks((s) => ({ ...s, honeywell: c }))} amount={honeywellRate} />
            <CheckRow label="Telguard Communicator" checked={checks.teleguard} onChange={(c) => setChecks((s) => ({ ...s, teleguard: c }))} amount={teleguardRate} />
            <CheckRow label="BuildingReports.com" checked={checks.br} onChange={(c) => setChecks((s) => ({ ...s, br: c }))} amount={brRate} />
            {isSF && <CheckRow label="SF Burg permit" checked={checks.sfburg} onChange={(c) => setChecks((s) => ({ ...s, sfburg: c }))} amount={sfBurgRate} />}
            <CheckRow label="UL certs" checked={checks.ulcerts} onChange={(c) => setChecks((s) => ({ ...s, ulcerts: c }))} amount={ulCertsRate} />
            {!adc.enabled && (
              <div className="cb-row">
                <input type="checkbox" checked={checks.bosch} onChange={(e) => setChecks((s) => ({ ...s, bosch: e.target.checked }))} />
                <label className="cb-name">Bosch Cloud</label>
                {checks.bosch
                  ? <NumInput value={boschAmt} onChange={setBoschAmt} step="0.01" style={{ width: 80 }} />
                  : <span className="cb-value">$0.00</span>}
              </div>
            )}
          </Card>
        )}

        {/* ── Labor / inspections ── */}
        {isFireType && (
          <Card title="Fire inspection calculator">
            <DeviceGrid
              devices={FIRE_DEVICES} rows={fire.rows} onRow={setFireRow}
              extra={[
                { label: 'Additional PM hours', value: fire.pmHrs, onChange: (v) => setFire((f) => ({ ...f, pmHrs: v })) },
                { label: 'No. of Technicians', value: fire.techs, onChange: (v) => setFire((f) => ({ ...f, techs: v })), min: 1, step: 1 },
              ]}
              results={[
                ['Annual inspection', fireCalc.annualHrs.toFixed(2) + ' hrs'],
                ['Semi-annual inspection', fireCalc.semiHrs.toFixed(2) + ' hrs'],
                ['Total annual hours', fireCalc.totalHrs.toFixed(2) + ' hrs'],
                ['Annual labor cost', money(fireCalc.laborCost)],
                [`Monthly to charge @ $${laborRatev}/hr`, money(fireCalc.monthlyCharge)],
              ]}
            />
          </Card>
        )}

        {(isAvType || systemType === 'Burglar Monitoring & Services' || systemType === 'Other/All Services') && (
          <Card title="PM inspection calculator">
            <DeviceGrid
              devices={pmDevices} rows={pm.rows} onRow={setPmRow} withFreq
              extra={[
                { label: 'Additional PM hours', value: pm.extraHrs, onChange: (v) => setPm((p) => ({ ...p, extraHrs: v })) },
                { label: 'No. of Technicians', value: pm.techs, onChange: (v) => setPm((p) => ({ ...p, techs: v })), min: 1, step: 1 },
              ]}
              results={[
                ['Device inspection', pmCalc.deviceHrs.toFixed(2) + ' hrs'],
                ['Additional PM', pmCalc.extraHrs.toFixed(2) + ' hrs'],
                ['Total annual hours', pmCalc.totalHrs.toFixed(2) + ' hrs'],
                ['Annual labor cost', money(pmCalc.laborCost)],
                [`Monthly to charge @ $${laborRatev}/hr`, money(pmCalc.monthlyCharge)],
              ]}
            />
          </Card>
        )}

        {systemType && !isTM && !isFireType && !isAvType && systemType !== 'Burglar Monitoring & Services' && (
          <Card title="Inspection / PM labor">
            <div className="grid-2">
              <Field label="Annual inspection or PM service labor hrs">
                <NumInput value={simpleInspHours} onChange={setSimpleInspHours} step="1" />
              </Field>
              <Field label={`Annual inspection labor cost (@ ${money(Number(labor.LaborCostPerHr) || 0)}/hr)`}>
                <input readOnly value={q.inspCost > 0 ? q.inspCost.toFixed(2) : ''} placeholder="0.00" />
              </Field>
            </div>
          </Card>
        )}

        {systemType && !isTM && (
          <Card title="Annual subcontractor cost">
            <div className="grid-2">
              <Field label="Annual subcontractor cost ($)"><NumInput value={annualSub} onChange={setAnnualSub} step="0.01" /></Field>
              {num(annualSub) > 0 && (
                <Field label="Subcontractor type">
                  <select value={subType} onChange={(e) => setSubType(e.target.value)}>
                    <option value="">— Select —</option>
                    <option>Sprinkler</option><option>Locksmith</option><option>Other</option>
                  </select>
                </Field>
              )}
            </div>
          </Card>
        )}

        {isAvType && (
          <Card title="Maintenance / spare parts">
            {avParts.map((p, i) => (
              <div className="site-row" key={i}>
                <TextInput value={p.desc} onChange={(v) => setAvParts((l) => l.map((x, j) => j === i ? { ...x, desc: v } : x))} placeholder="Description" />
                <NumInput value={p.unitCost} onChange={(v) => setAvParts((l) => l.map((x, j) => j === i ? { ...x, unitCost: v } : x))} step="0.01" placeholder="Unit cost" />
                <NumInput value={p.qty} onChange={(v) => setAvParts((l) => l.map((x, j) => j === i ? { ...x, qty: v } : x))} step="1" placeholder="Qty" />
                <button type="button" className="btn-x" onClick={() => setAvParts((l) => l.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            <button type="button" className="btn-add" onClick={() => setAvParts((l) => [...l, { desc: '', unitCost: '', qty: 1 }])}>+ Add part</button>
            <div className="builder-total"><span>Total annual parts cost</span><span>{money(avMaintTotal)}</span></div>
          </Card>
        )}
      </div>

      {/* ── RIGHT: Margin & RMR Analysis ── */}
      <div className="qb-right">
        <Card title="Margin & RMR Analysis">
          <div className="oh-row">
            <label>Overhead rate</label>
            <RateSelect group="overheadRate" options={options} value={String(overheadRatev)} onChange={(v) => setOverheadRate(Number(v))} placeholder={pct(overheadRatev)} />
            <div className="oh-toggle">
              <button className={ohMethod === 'revenue' ? 'active' : ''} onClick={() => setOhMethod('revenue')}>Revenue</button>
              <button className={ohMethod === 'cost' ? 'active' : ''} onClick={() => setOhMethod('cost')}>Direct Costs</button>
            </div>
          </div>

          {!isTM && (
            <>
              <SectionLabel>Monitoring &amp; services</SectionLabel>
              <Slider label="Gross margin target" value={svcGMv} onChange={setSvcGM} min={30} max={80} format={(v) => v + '%'} />
              <div className="big-metrics">
                <BigMetric
                  label="Mon. RMR"
                  value={q.rmrIsManual ? money(quotedMonthlyTotal) + '/mo' : (q.monOnlyCosts > 0 ? money(q.monRMR) + '/mo' : '—')}
                  sub={q.rmrIsManual ? `manual quote · recommended ${money(q.recommendedRMR)}/mo` : `@ ${svcGMv}% GM`}
                />
                <BigMetric
                  label="Gross margin"
                  value={(q.rmrIsManual ? q.effGM : q.monGM) != null ? pct(q.rmrIsManual ? q.effGM : q.monGM) : '—'}
                  sub={(q.rmrIsManual ? q.effGM : q.monGM) != null ? money(q.rmrIsManual ? q.annGP : q.monAnnGP) + ' gross profit' : '—'}
                  color={gpColor(q.rmrIsManual ? q.effGM : q.monGM)}
                />
              </div>
              <MetricRow label="Monthly monitoring costs" value={money(monthlyCosts)} />
              <MetricRow label="Monthly monitoring billed" value={money(q.rmrIsManual ? quotedMonthlyTotal : q.monRMR)} />
              <MetricRow label="Annual monitoring billed" value={money(q.rmrIsManual ? q.annRev : q.monAnnRev)} />
              <MetricRow total label="Monitoring gross profit" value={money(q.rmrIsManual ? q.annGP : q.monAnnGP)} />
            </>
          )}

          {inspHours > 0 && (
            <>
              <SectionLabel>Labor</SectionLabel>
              <Slider label="Bill rate ($/hr)" value={laborRatev} onChange={setLaborRate} min={100} max={300} step={5} format={(v) => '$' + v} />
              <div className="big-metrics">
                <BigMetric label="Labor RMR" value={q.inspBilled > 0 ? money(q.laborRMR) + '/mo' : '—'} sub={`billed @ $${laborRatev}/hr`} />
                <BigMetric label="Labor margin" value={q.laborMargin != null ? pct(q.laborMargin) : '—'} sub={q.laborMargin != null ? money(q.laborGP) + ' gross profit' : `cost @ $${labor.LaborCostPerHr ?? '—'}/hr`} />
              </div>
              <MetricRow label={isFireType ? 'Annual fire inspection cost' : 'Annual labor cost'} value={money(q.inspCost)} />
              <MetricRow label="Annual labor billed" value={money(q.inspBilled)} />
              <MetricRow total label="Labor gross profit" value={money(q.laborGP)} />
            </>
          )}

          {num(annualSub) > 0 && !isTM && (
            <>
              <SectionLabel>Annual subcontractor costs</SectionLabel>
              <Slider label="Markup" value={subMarkupv} onChange={setSubMarkup} min={0} max={100} format={(v) => v + '%'} />
              <div className="big-metrics">
                <BigMetric label="Subcontractor RMR" value={money(q.subRMR) + '/mo'} sub={`@ ${subMarkupv}% markup`} />
                <BigMetric label="Sub margin" value={q.subMargin != null ? pct(q.subMargin) : '—'} sub={money(q.subGP) + ' gross profit'} />
              </div>
              <MetricRow label="Annual sub cost" value={money(num(annualSub))} />
              <MetricRow label="Annual sub billed" value={money(q.subBilled)} />
            </>
          )}

          {avMaintTotal > 0 && (
            <>
              <SectionLabel>Maintenance</SectionLabel>
              <Slider label="Maint. GM" value={avMaintGMv} onChange={setAvMaintGM} min={20} max={80} format={(v) => v + '%'} />
              <div className="big-metrics">
                <BigMetric label="Maint. RMR" value={money(q.avMaintRMR) + '/mo'} sub={`@ ${avMaintGMv}% GM`} />
                <BigMetric label="Maint. GP" value={money(q.avMaintGP)} sub={`billed ${money(q.avMaintBilled)}/yr`} />
              </div>
            </>
          )}

          {/* Quote summary */}
          <div className="quote-summary">
            <div className="quote-summary-title">Quote summary</div>
            {!isTM && (
              <>
                <div className="qs-label">{q.rmrIsManual ? 'Quoted Monthly (Manual)' : 'Recommended RMR'}</div>
                <div className="qs-rmr">{q.hasAny ? money(q.rmrEff) : '—'}</div>
                <div className="qs-sub">
                  {q.rmrIsManual
                    ? `recommended ${money(q.recommendedRMR)}/mo @ ${svcGMv}% GM`
                    : `svc ${svcGMv}% GM · labor $${laborRatev}/hr`}
                </div>
                <MetricRow label="Annual revenue" value={q.hasAny ? money(q.annRev) + '/yr' : '—'} />
                <MetricRow label="Annual overhead" value={money(q.annOH)} />
                <MetricRow label="Net profit" value={money(q.annNP)} />
                <MetricRow total label="Net margin" value={q.nm != null ? pct(q.nm) : '—'} />
              </>
            )}
            {isTM && <p className="hint">T&amp;M / flat-rate estimate — RMR analysis not applicable. Materials &amp; labor line-item builder is tracked as a follow-up port.</p>}
          </div>
        </Card>
      </div>
    </div>
  );
}

// Shared device-hours grid used by both inspection calculators
function DeviceGrid({ devices, rows, onRow, withFreq, extra, results }) {
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
