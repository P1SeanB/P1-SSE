import React, { useMemo, useState } from 'react';
import { useAppState, lookupZip } from '../../store/AppState.jsx';
import { computeQuote, calcFireInspection, calcPmInspection, TM_TYPES } from '../../lib/calc.js';
import { money, pct, num } from '../../lib/format.js';
import {
  Card, Field, TextInput, NumInput, Slider, MetricRow, BigMetric,
  SectionLabel, CheckRow, RateSelect,
} from '../../components/ui.jsx';
import {
  FIRE_DEVICES, PM_STANDARD_DEVICES, PM_AV_DEVICES, ESTIMATE_TYPES, blankDeviceState,
} from './deviceRows.js';
import EstimateDetails, { newEstimateDetails } from './EstimateDetails.jsx';
import OneTimeWork from './OneTimeWork.jsx';
import AdcPanel from './AdcPanel.jsx';
import MonthlyCosts from './MonthlyCosts.jsx';
import DeviceGrid from './DeviceGrid.jsx';
import { useMonthlyCosts } from './useMonthlyCosts.js';
import Subcontractor, { newSubcontractor } from './Subcontractor.jsx';
import QuoteHeader from './QuoteHeader.jsx';
import CustomerQuote from './CustomerQuote.jsx';
import { gatherEstimate, restoreEstimate, estimateFilename } from './estimateFile.js';
import { useOneTimeWork } from './useOneTimeWork.js';

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
  const [notes, setNotes] = useState('');

  // Estimate identity, billing address and the one-time charges (shipping, material
  // sales tax). One home for each: the identity fields used to be duplicated inline
  // in the Customer info card AND in EstimateDetails, which is how two inputs end up
  // disagreeing about the same estimate number.
  const [details, setDetails] = useState(newEstimateDetails);

  // Materials, installation labour, subcontracted lines and rental equipment.
  const work = useOneTimeWork(rates);

  // ── Labor / inspection ────────────────────────────────────────────────────
  const [fire, setFire] = useState(() => ({ rows: blankDeviceState(FIRE_DEVICES), pmHrs: '', techs: 1 }));
  const [pm, setPm] = useState(() => ({ rows: blankDeviceState([...PM_STANDARD_DEVICES, ...PM_AV_DEVICES], true), extraHrs: '', techs: 1 }));
  const [simpleInspHours, setSimpleInspHours] = useState('');
  // Which inspection worksheets this quote uses — the legacy's cb-nfpa, cb-pm and
  // cb-pm-av-other (:2043-2045).
  //
  // null means "follow the estimate type", which is what the legacy's
  // dataset.userSet flag tracks (:2043): picking Fire turns NFPA on, and it STAYS
  // under the estimator's control the moment they touch it. Without the third state
  // a toggle is either overwritten on every type change or never follows the type at
  // all, and both read as the checkbox being broken.
  const [inspOn, setInspOn] = useState({ nfpa: null, pm: null, pmAvOther: null });
  const [showQuote, setShowQuote] = useState(false);
  // Anything a .p1est carried that this app does not read, kept so saving an imported
  // estimate does not strip it — see estimateFile.js.
  const [passthrough, setPassthrough] = useState({});
  // Subcontracted work: the annual cost and the TYPE that explains it on a proposal.
  // One object rather than two loose fields, because the type without the cost is
  // meaningless and the cost without the type invites the question the type answers.
  const [sub, setSub] = useState(newSubcontractor);
  const annualSub = sub.annualCost;
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
  const isOtherAll = systemType === 'Other/All Services';
  const nfpaOn = inspOn.nfpa ?? isFireType;
  const pmOn = inspOn.pm ?? (isAvType || systemType === 'Burglar Monitoring & Services' || isOtherAll);
  const pmAv = inspOn.pmAvOther ?? isAvType;
  const isCommercial = siteType === 'Commercial';
  const site1 = sites[0];

  // ── Monthly monitoring / platform costs (legacy COST_IDS, :3491) ─────────
  // Owned by useMonthlyCosts, the sibling of useOneTimeWork.
  const monthly = useMonthlyCosts(rates, { systemType, isCommercial, city: sites[0]?.city });
  const monthlyCosts = monthly.total;


  // Inspection hours: fire calculator, PM calculator, or simple entry
  const fireCalc = useMemo(() => calcFireInspection(
    FIRE_DEVICES.map((d) => ({ ...fire.rows[d.key], semi: d.semi })),
    fire.pmHrs, fire.techs, Number(labor.LaborCostPerHr) || 0, laborRatev,
  ), [fire, labor, laborRatev]);

  const pmDevices = pmAv ? PM_AV_DEVICES : PM_STANDARD_DEVICES;
  const pmCalc = useMemo(() => calcPmInspection(
    pmDevices.map((d) => pm.rows[d.key]),
    pm.extraHrs, pm.techs, Number(labor.LaborCostPerHr) || 0, laborRatev,
  ), [pm, pmDevices, labor, laborRatev]);

  // Which worksheet supplies the hours — legacy :8113-8120 (PM), :8196-8204 (fire)
  // and updateCombinedInspHours (:8139-8146).
  //
  // ONLY "Other/All Services" ADDS THE TWO TOGETHER. Every other type takes the hours
  // from whichever worksheet is switched on. This previously read the estimate type
  // directly and had no branch for Other/All Services at all, so a PM worksheet filled
  // in on one of those quotes contributed NOTHING — the card rendered, the hours
  // totalled on screen, and the RMR ignored them.
  const inspHours = isOtherAll
    ? (nfpaOn ? fireCalc.totalHrs : 0) + (pmOn ? pmCalc.totalHrs : 0)
    : nfpaOn ? fireCalc.totalHrs
    : pmOn ? pmCalc.totalHrs
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

  // Overhead is applied with the same rate and method the recurring side uses, so a
  // quote carrying both halves does not answer the overhead question twice.
  const oneTimeMargin = work.margin(Number(overheadRatev), ohMethod);

  // ── Header actions ────────────────────────────────────────────────────────
  //
  // Clear, import, save, print. All four were written in QuoteHeader.jsx in Aug 2026
  // and wired to nothing; these are the handlers it was waiting for.

  /** Everything the monitoring half of the quote holds — the legacy's clearSystems. */
  const clearSystems = () => monthly.clear();

  const clearAll = () => {
    clearSystems();
    work.clear();
    setSystemType(''); setSiteType(''); setNotes('');
    setDetails(newEstimateDetails());
    setFire({ rows: blankDeviceState(FIRE_DEVICES), pmHrs: '', techs: 1 });
    setPm({ rows: blankDeviceState([...PM_STANDARD_DEVICES, ...PM_AV_DEVICES], true), extraHrs: '', techs: 1 });
    setSimpleInspHours(''); setInspOn({ nfpa: null, pm: null, pmAvOther: null });
    setSub(newSubcontractor()); setAvParts([]);
    setSvcGM(null); setSubMarkup(null); setAvMaintGM(null); setLaborRate(null);
    setOverheadRate(null); setOhMethod('revenue');
    setPassthrough({});
    updateCustomer({ companyName: '', contactName: '', phone: '', email: '' });
    updateSite(site1.id, { address: '', city: '', state: '', zip: '', monthlyRate: '' });
  };

  const snapshot = () => ({
    customer, sites, systemType, siteType, notes, details,
    inspHours, avMaintTotal, sub, avParts,
    adcEnabled: monthly.adcEnabled, adcCfg: monthly.adcCfg,
    connectOne: monthly.connectOne, alarmNet: monthly.alarmNet,
    gcsChecks: monthly.gcsChecks, checks: monthly.checks,
    nfpaOn, pmOn, pmAv,
    rows: work.rows, tmSubRows: work.tmSubRows, rental: work.rental,
    matMarkup: work.matMarkup, tmSubGM: work.tmSubGM,
    svcGM: svcGMv, subMarkup: subMarkupv, avMaintGM: avMaintGMv,
    laborRate: laborRatev, overheadRate: overheadRatev, ohMethod,
    passthrough,
  });

  const exportEstimate = () => {
    const data = snapshot();
    const blob = new Blob([JSON.stringify(gatherEstimate(data), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = estimateFilename(data);
    a.click();
    URL.revokeObjectURL(url);
  };

  const importEstimate = (raw) => {
    const d = restoreEstimate(raw);
    updateCustomer(d.customer);
    updateSite(site1.id, d.site);
    setSystemType(d.systemType); setSiteType(d.siteType); setNotes(d.notes);
    setDetails(d.details);
    setSimpleInspHours(d.simpleInspHours);
    setSub(d.sub); setAvParts(d.avParts);
    monthly.setAdcEnabled(d.adcEnabled); monthly.setAdcCfg(d.adcCfg);
    monthly.setConnectOne(d.connectOne); monthly.setAlarmNet(d.alarmNet);
    monthly.setGcsChecks(d.gcsChecks); monthly.setChecks(d.checks);
    setInspOn(d.inspOn);
    work.setRows(d.rows); work.setTmSubRows(d.tmSubRows); work.setRental(d.rental);
    if (d.sliders.matMarkup != null) work.setMatMarkup(d.sliders.matMarkup);
    if (d.sliders.tmSubGM != null) work.setTmSubGM(d.sliders.tmSubGM);
    setSvcGM(d.sliders.svcGM); setSubMarkup(d.sliders.subMarkup);
    setAvMaintGM(d.sliders.avMaintGM); setLaborRate(d.sliders.laborRate);
    setOverheadRate(d.sliders.overheadRate); setOhMethod(d.sliders.ohMethod);
    setPassthrough(d.passthrough);
  };

  const setFireRow = (key, patch) => setFire((f) => ({ ...f, rows: { ...f.rows, [key]: { ...f.rows[key], ...patch } } }));
  const setPmRow = (key, patch) => setPm((p) => ({ ...p, rows: { ...p.rows, [key]: { ...p.rows[key], ...patch } } }));

  async function onZipBlur(zip) {
    const found = await lookupZip(zip);
    if (found) updateSite(site1.id, { city: found.city, state: found.state });
  }

  return (
    <div className="qb-layout">
      <div className="qb-left">
        <QuoteHeader
          onClearAll={clearAll}
          onClearSystems={clearSystems}
          onPrint={() => setShowQuote(true)}
          onImport={importEstimate}
          onExport={exportEstimate}
        />

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
          <div className="grid-2">
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
            {/* Estimate name, estimator and estimate number live on the Estimate
                Details card below — see the note beside `details`. */}
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
          <MonthlyCosts m={monthly} rates={rates} systemType={systemType} />
        )}

        {/* ── Alarm.com package ──
            Its own card rather than a panel inside Monthly costs: 68 controls across
            nine collapsible sections, all of them priced by src/lib/adc.js. */}
        {systemType && !isTM && monthly.adcEnabled && (
          <AdcPanel value={monthly.adcCfg} onChange={monthly.setAdcCfg} rates={rates || {}} />
        )}

        {/* ── Labor / inspections ── */}
        {systemType && !isTM && (
          <Card title="Inspection services">
            <CheckRow label="NFPA 72 inspections (itemised worksheet)" checked={nfpaOn}
              onChange={(on) => setInspOn((i) => ({ ...i, nfpa: on }))} />
            <CheckRow label="PM inspection services" checked={pmOn}
              onChange={(on) => setInspOn((i) => ({ ...i, pm: on }))} />
            {pmOn && (
              <CheckRow label="A/V devices instead of life-safety devices" checked={pmAv}
                onChange={(on) => setInspOn((i) => ({ ...i, pmAvOther: on }))} />
            )}
            {isOtherAll && nfpaOn && pmOn && (
              <p className="hint">
                Other/All Services adds both worksheets together — {fireCalc.totalHrs.toFixed(2)} fire
                {' + '}{pmCalc.totalHrs.toFixed(2)} PM = {inspHours.toFixed(2)} hrs/yr.
              </p>
            )}
          </Card>
        )}

        {nfpaOn && !isTM && (
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

        {pmOn && !isTM && (
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

        {systemType && !isTM && !nfpaOn && !pmOn && (
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
          <Subcontractor value={sub} onChange={setSub} subMarkup={subMarkupv / 100} />
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

        {/* ── One-time work ──
            Shown for every estimate type, not only T&M. A monitoring quote routinely
            carries install work, and gating this on isTM is exactly the mistake the
            legacy corrected in Aug 2026 (:4890-4893) — install work on a monitoring
            quote then showed no net figure at all. */}
        <OneTimeWork
          work={work}
          charges={details}
          rates={rates}
          jobLabel={[customer.companyName, details.agreementName].filter(Boolean).join(' — ')}
        />

        <EstimateDetails value={details} onChange={setDetails} site={site1} />
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

          {/* ── Combined one-time ──
              Legacy :4890-4922. Shown for EVERY estimate type, which is the point:
              this used to be gated on the estimate being T&M, so install work on a
              monitoring quote never showed overhead or a net figure.

              Tax and shipping are absent here on purpose. Neither is Point 1's margin
              to make, so neither belongs in one — see computeOneTimeMargin. */}
          {oneTimeMargin.hasOneTime && (
            <>
              <SectionLabel>One-time work</SectionLabel>
              <div className="big-metrics">
                <BigMetric label="One-time billed" value={money(oneTimeMargin.billed)}
                  sub={oneTimeMargin.markupPct != null ? `${Math.round(oneTimeMargin.markupPct)}% over cost` : '—'} />
                <BigMetric label="Gross margin"
                  value={oneTimeMargin.gmPct != null ? pct(oneTimeMargin.gmPct) : '—'}
                  sub={money(oneTimeMargin.gp) + ' gross profit'}
                  color={gpColor(oneTimeMargin.gmPct)} />
              </div>
              <MetricRow label="One-time cost" value={money(oneTimeMargin.cost)} />
              <MetricRow label={`Overhead (${Math.round(overheadRatev * 100)}% of ${ohMethod === 'cost' ? 'cost' : 'billed'})`}
                value={money(oneTimeMargin.overhead)} />
              <MetricRow label="Net profit" value={money(oneTimeMargin.netProfit)} />
              <MetricRow total label="Net margin"
                value={oneTimeMargin.netMarginPct != null ? pct(oneTimeMargin.netMarginPct) : '—'} />
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
            {isTM && <p className="hint">T&amp;M / flat-rate estimate — RMR analysis not applicable. The job prices from the one-time work above.</p>}
          </div>
        </Card>
      </div>

      {showQuote && (
        <CustomerQuote
          customer={customer} site={site1} details={details}
          systemType={systemType} siteType={siteType}
          quote={q}
          monthlyBilled={q.rmrIsManual ? quotedMonthlyTotal : q.rmrEff}
          work={work} charges={details}
          onClose={() => setShowQuote(false)}
        />
      )}
    </div>
  );
}
