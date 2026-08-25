import React, { useEffect } from 'react';
import { Card, Field, NumInput, SectionLabel, CheckRow, RateSelect, optionPrice } from '../../components/ui';
import { computeAdc, isCommercialBase, hasCvIntercom, doorOptions, addonsForBase } from '../../lib/adc';

// Alarm.com configuration — the legacy's adc-* section (index.html:4018-4487).
//
// ALL PRICING IS DELEGATED to src/lib/adc.js, which is covered by npm run parity:adc.
// This file decides what is VISIBLE and what resets; it never adds up money.
//
// Option lists come from rates.dropdownOptions, which is the pricing_option table
// (db/schema.pg.sql). The legacy stored raw <option> markup in a Supabase JSON blob
// and injected it as HTML — so a price change meant editing markup, and the app
// rendered whatever the database said, tags and all. Here a dropdown is data.

// Sections the estimator opens and closes — :4018 adcToggleSection.
const SECTIONS = [
  { toggle: 'video', label: 'Video Monitoring' },
  { toggle: 'access', label: 'Smarter Access Control', commercialOnly: true },
  { toggle: 'comms', label: 'Communications' },
  { toggle: 'alerts', label: 'Alerts & Automation' },
  { toggle: 'energy', label: 'Energy' },
  { toggle: 'fleet', label: 'Cars & Fleet' },
  { toggle: 'openeye', label: 'OpenEye', commercialOnly: true },
  { toggle: 'remote', label: 'Remote Monitoring' },
  { toggle: 'wellness', label: 'Wellness' },
];

// The adc-x-* add-on checkboxes. Each carries its own monthly amount, which comes
// from the rate tables rather than from here — the key is the pricing_option value.
const ADDONS = [
  ['audio-integration', 'Audio integration'],
  ['commercial-supervision-ul', 'Commercial supervision (UL)'],
  ['energy-monitoring', 'Energy monitoring'],
  ['enphase-integration', 'Enphase integration'],
  ['garage-door-and-gate', 'Garage door & gate'],
  ['irrigation-control', 'Irrigation control'],
  ['liftmaster-integration', 'LiftMaster integration'],
  ['lights', 'Lights'],
  ['lights-and-thermostat-bundle', 'Lights & thermostat bundle'],
  ['locks', 'Locks'],
  ['lutron-integration', 'Lutron integration'],
  ['my-circle', 'My Circle'],
  ['severe-weather-alerts', 'Severe weather alerts'],
  ['shades', 'Shades'],
  ['solar-integration', 'Solar integration'],
  ['thermostats', 'Thermostats'],
  ['voice-notifications-alarms', 'Voice notifications — alarms'],
  ['voice-notifications-non-alarms', 'Voice notifications — non-alarms'],
  ['water-management', 'Water management'],
  ['water-management-plus', 'Water management +'],
  ['weather-to-panel', 'Weather to panel'],
  ['wireless-two-way-voice', 'Wireless two-way voice'],
];

// Video scope checkboxes — descriptive rather than priced; they record what the
// camera package has to cover.
const VIDEO_SCOPE = [
  ['doorbell', 'Doorbell'],
  ['onboard-rec', 'Onboard recording'],
  ['audio-nondb', 'Audio (non-doorbell)'],
  ['digital-input', 'Digital input'],
  ['third-party', 'Third-party cameras'],
  ['biz-analytics', 'Business analytics'],
];

const money = (n) => (n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export const newAdcState = () => ({
  base: '',
  sections: {},                    // toggle name → open
  video: { value: '', type: '', cameras: 1, expansions: '', servers: 0, intercom: '' },
  videoScope: {},
  cvIntercom: { devices: 0, users: 0 },
  access: { enabled: false, packageValue: '', package: '', bundle: '', doors: '', mobile10: '', mobile100: '' },
  addons: {},
  sensors: '', aid: '', cars: '', fleet: '', comms: '',
  flexIo: '', cellConnector: '', verizonData: '', imageEvents: '',
  supervision: '', noonlightLicenses: 0,
  openEye: false, enterpriseWellness: false, wellness: false,
  scheduledArm: false, esc: false, mlEsc: false, mobileCreds: false,
});

export default function AdcPanel({ value: adc, onChange, rates = {} }) {
  const set = (patch) => onChange({ ...adc, ...patch });
  const commercial = isCommercialBase(adc.base);

  // Commercial-only features are silently unchecked when the base package moves away
  // from Commercial — :4334-4360. Without this, an estimator downgrades the package
  // and the quote keeps charging for Access Control and OpenEye, which the customer
  // is not entitled to and the portal will not provision.
  useEffect(() => {
    if (commercial) return;
    const needsReset =
      adc.access.enabled || adc.openEye || adc.enterpriseWellness ||
      (adc.sections.access || adc.sections.openeye);
    if (!needsReset) return;
    onChange({
      ...adc,
      sections: { ...adc.sections, access: false, openeye: false },
      access: { ...adc.access, enabled: false, package: '', packageValue: '', bundle: '', doors: '', mobile10: '', mobile100: '' },
      openEye: false,
      enterpriseWellness: false,
      mobileCreds: false,
    });
  }, [commercial]); // eslint-disable-line react-hooks/exhaustive-deps

  // Which add-ons this base package offers, and at what price. Keyed by id so the
  // checkbox rows below read both without recomputing per row.
  const addonMatrix = React.useMemo(() => {
    const map = {};
    for (const a of addonsForBase(rates.adc, adc.base)) map[a.id] = a;
    return map;
  }, [rates.adc, adc.base]);

  // Changing package can withdraw an add-on entirely. The legacy force-unchecks it
  // (:15762) rather than leaving a hidden box ticked, and that matters: a selection you
  // cannot see is one you cannot remove, and it would ride along into the saved quote.
  useEffect(() => {
    const stale = Object.keys(adc.addons || {}).filter(
      (k) => adc.addons[k] && addonMatrix[k] && !addonMatrix[k].available,
    );
    if (!stale.length) return;
    const next = { ...adc.addons };
    for (const k of stale) next[k] = false;
    set({ addons: next });
  }, [addonMatrix]); // eslint-disable-line react-hooks/exhaustive-deps

  // The same call the quote total makes, so the figure shown here and the figure
  // charged are the same number by construction.
  const priced = computeAdc(
    {
      base: adc.base,
      video: adc.video,
      cvIntercom: adc.cvIntercom,
      access: adc.access,
      // IDS, not amounts — computeAdc resolves each against the selected package.
      //
      // This used to send one flat price per add-on, looked up from a pricing_option
      // group named 'adc-addons' that does not exist in the rate data at all, so every
      // add-on contributed exactly nothing. Even with rows it would have been wrong:
      // 22 of the 24 add-ons are priced PER PACKAGE, free on the packages that bundle
      // them and chargeable on the ones that do not.
      addons: Object.entries(adc.addons).filter(([, on]) => on).map(([k]) => k),
      sensors: adc.sensors, aid: adc.aid, cars: adc.cars, fleet: adc.fleet, comms: adc.comms,
      flexIo: adc.flexIo, cellConnector: adc.cellConnector,
      verizonData: adc.verizonData, imageEvents: adc.imageEvents,
      supervision: adc.supervision,
      noonlightLicenses: adc.noonlightLicenses,
      liftmasterIntegration: !!adc.addons['liftmaster-integration'],
    },
    rates,
  );

  const opts = rates.dropdownOptions || {};
  const showCvIntercom = hasCvIntercom(adc.video.value);
  const isExpansion = adc.video.type === 'expansion';
  const isPerCamera = Number(adc.video.value) > 0 && !isExpansion && adc.video.type !== 'flat';

  const section = (name) => ({
    open: !!adc.sections[name],
    toggle: () => set({ sections: { ...adc.sections, [name]: !adc.sections[name] } }),
  });

  return (
    <Card title="Alarm.com">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
        <Field label="Base package">
          <RateSelect group="adc-base" options={opts} value={adc.base}
            onChange={(v) => set({ base: v })} />
        </Field>

        {SECTIONS.map((s) => {
          if (s.commercialOnly && !commercial) return null;
          const st = section(s.toggle);
          return (
            <div key={s.toggle}>
              <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', cursor: 'pointer' }}>
                <input type="checkbox" checked={st.open} onChange={st.toggle} />
                <SectionLabel>{s.label}</SectionLabel>
              </label>

              {st.open && s.toggle === 'video' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', paddingLeft: '1.5rem' }}>
                  <Field label="Video package">
                    <RateSelect group="adc-video" options={opts} value={adc.video.value}
                      onChange={(v, opt) => set({ video: { ...adc.video, value: v, type: opt?.type || '' } })} />
                  </Field>

                  {/* Per-camera tiers price the rate times the count; the legacy
                      forces the count back to 1 when the tier is not per-camera
                      (:4381) so a stale count cannot inflate a flat package. */}
                  {isPerCamera && (
                    <Field label="Cameras">
                      <NumInput value={adc.video.cameras} min="1" step="1"
                        onChange={(v) => set({ video: { ...adc.video, cameras: v } })} />
                    </Field>
                  )}

                  {isExpansion && (
                    <>
                      <Field label="Expansions">
                        <RateSelect group="adc-expansions" options={opts} value={adc.video.expansions}
                          onChange={(v) => set({ video: { ...adc.video, expansions: v } })} />
                      </Field>
                      <Field label="Servers">
                        <NumInput value={adc.video.servers} min="0" step="1"
                          onChange={(v) => set({ video: { ...adc.video, servers: v } })} />
                      </Field>
                      <Field label="Intercom">
                        <RateSelect group="adc-intercom" options={opts} value={adc.video.intercom}
                          onChange={(v) => set({ video: { ...adc.video, intercom: v } })} />
                      </Field>
                    </>
                  )}

                  {/* Only Commercial Video tiers offer it — :4396. */}
                  {showCvIntercom && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                      <Field label="Intercom devices">
                        <NumInput value={adc.cvIntercom.devices} min="0" step="1"
                          onChange={(v) => set({ cvIntercom: { ...adc.cvIntercom, devices: v } })} />
                      </Field>
                      <Field label="Intercom users">
                        <NumInput value={adc.cvIntercom.users} min="0" step="1"
                          onChange={(v) => set({ cvIntercom: { ...adc.cvIntercom, users: v } })} />
                      </Field>
                    </div>
                  )}

                  <div>
                    <SectionLabel>Scope</SectionLabel>
                    {VIDEO_SCOPE.map(([k, label]) => (
                      <CheckRow key={k} label={label} checked={!!adc.videoScope[k]}
                        onChange={(on) => set({ videoScope: { ...adc.videoScope, [k]: on } })} />
                    ))}
                  </div>
                </div>
              )}

              {st.open && s.toggle === 'access' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', paddingLeft: '1.5rem' }}>
                  <Field label="Access package">
                    <select value={adc.access.package}
                      onChange={(e) => set({ access: { ...adc.access, package: e.target.value, enabled: e.target.value !== '0' && e.target.value !== '' } })}>
                      <option value="0">— None —</option>
                      <option value="std">Access Control</option>
                      <option value="sacp">Access Control Plus</option>
                    </select>
                  </Field>
                  {adc.access.enabled && (
                    <>
                      <Field label="Bundle">
                        <RateSelect group={adc.access.package === 'sacp' ? 'adc-access-bundle-sacp' : 'adc-access-bundle'}
                          options={opts} value={adc.access.bundle}
                          onChange={(v) => set({ access: { ...adc.access, bundle: v } })} />
                      </Field>
                      {/* Generated from the per-door rate rather than stored, so the
                          list cannot drift from the price — :4227. */}
                      <Field label="Additional doors">
                        <select value={adc.access.doors}
                          onChange={(e) => set({ access: { ...adc.access, doors: e.target.value } })}>
                          {doorOptions(adc.access.package, rates).map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Mobile credentials (10-packs)">
                        <RateSelect group="adc-mobile-10" options={opts} value={adc.access.mobile10}
                          onChange={(v) => set({ access: { ...adc.access, mobile10: v } })} />
                      </Field>
                      <Field label="Mobile credentials (100-packs)">
                        <RateSelect group="adc-mobile-100" options={opts} value={adc.access.mobile100}
                          onChange={(v) => set({ access: { ...adc.access, mobile100: v } })} />
                      </Field>
                    </>
                  )}
                </div>
              )}

              {st.open && s.toggle === 'comms' && (
                <div style={{ paddingLeft: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <Field label="Communications"><RateSelect group="adc-comms" options={opts} value={adc.comms} onChange={(v) => set({ comms: v })} /></Field>
                  <Field label="Cell connector"><RateSelect group="adc-cellconnector" options={opts} value={adc.cellConnector} onChange={(v) => set({ cellConnector: v })} /></Field>
                  <Field label="Verizon data"><RateSelect group="adc-verizon-data" options={opts} value={adc.verizonData} onChange={(v) => set({ verizonData: v })} /></Field>
                  <Field label="Flex IO"><RateSelect group="adc-flexio" options={opts} value={adc.flexIo} onChange={(v) => set({ flexIo: v })} /></Field>
                </div>
              )}

              {st.open && s.toggle === 'fleet' && (
                <div style={{ paddingLeft: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <Field label="Cars"><RateSelect group="adc-cars" options={opts} value={adc.cars} onChange={(v) => set({ cars: v })} /></Field>
                  <Field label="Fleet"><RateSelect group="adc-fleet" options={opts} value={adc.fleet} onChange={(v) => set({ fleet: v })} /></Field>
                </div>
              )}

              {st.open && s.toggle === 'remote' && (
                <div style={{ paddingLeft: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <Field label="Supervision">
                    <select value={adc.supervision} onChange={(e) => set({ supervision: e.target.value })}>
                      <option value="">— None —</option>
                      <option value="six">Six-hour</option>
                      <option value="hourly">Hourly</option>
                    </select>
                  </Field>
                  <Field label="Noonlight licences">
                    <NumInput value={adc.noonlightLicenses} min="0" step="1"
                      onChange={(v) => set({ noonlightLicenses: v })} />
                  </Field>
                  <Field label="Image events"><RateSelect group="adc-img-events" options={opts} value={adc.imageEvents} onChange={(v) => set({ imageEvents: v })} /></Field>
                </div>
              )}

              {st.open && s.toggle === 'openeye' && (
                <div style={{ paddingLeft: '1.5rem' }}>
                  <CheckRow label="OpenEye" checked={adc.openEye} onChange={(on) => set({ openEye: on })} />
                </div>
              )}

              {st.open && s.toggle === 'wellness' && (
                <div style={{ paddingLeft: '1.5rem' }}>
                  <CheckRow label="Wellness" checked={adc.wellness} onChange={(on) => set({ wellness: on })} />
                  {commercial && (
                    <CheckRow label="Enterprise wellness" checked={adc.enterpriseWellness}
                      onChange={(on) => set({ enterpriseWellness: on })} />
                  )}
                </div>
              )}

              {st.open && (s.toggle === 'alerts' || s.toggle === 'energy') && (
                <div style={{ paddingLeft: '1.5rem' }}>
                  {ADDONS.filter(([k]) =>
                    s.toggle === 'energy'
                      ? /energy|solar|enphase|thermostat|lights|shades|irrigation|water/.test(k)
                      : !/energy|solar|enphase|thermostat|lights|shades|irrigation|water/.test(k),
                  )
                    // Hidden when the selected package does not offer it at all — the
                    // legacy hides the row rather than showing an unbuyable option.
                    .filter(([k]) => !addonMatrix[k] || addonMatrix[k].available)
                    .map(([k, label]) => (
                      <CheckRow key={k} label={label} checked={!!adc.addons[k]}
                        amount={addonMatrix[k] ? addonMatrix[k].price : 0}
                        onChange={(on) => set({ addons: { ...adc.addons, [k]: on } })} />
                    ))}
                </div>
              )}
            </div>
          );
        })}

        <div>
          <SectionLabel>Sensors &amp; devices</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
            <Field label="Sensors"><RateSelect group="adc-sensors" options={opts} value={adc.sensors} onChange={(v) => set({ sensors: v })} /></Field>
            <Field label="AID"><RateSelect group="adc-aid" options={opts} value={adc.aid} onChange={(v) => set({ aid: v })} /></Field>
          </div>
        </div>

        {/* LiftMaster carries an automatic surcharge whenever the integration is
            checked — :4475. Saying so is what stops it reading as a pricing bug. */}
        {adc.addons['liftmaster-integration'] && priced.parts.liftmaster > 0 && (
          <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-muted, #6b7688)' }}>
            Includes the LiftMaster surcharge of {money(priced.parts.liftmaster)}/mo, applied
            automatically with the integration.
          </p>
        )}

        <div style={{ borderTop: '1px solid var(--border, #d8dbe0)', paddingTop: '0.6rem', display: 'flex', justifyContent: 'space-between' }}>
          <strong>Alarm.com monthly</strong>
          <strong>{priced.total > 0 ? `${money(priced.total)}/mo` : '—'}</strong>
        </div>
      </div>
    </Card>
  );
}
