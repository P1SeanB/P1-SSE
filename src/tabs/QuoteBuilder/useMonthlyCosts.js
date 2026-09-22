import { useMemo, useState } from 'react';
import { computeAdc } from '../../lib/adc.js';
import { adcInputFrom } from './adcInput.js';
import { newAdcState } from './estimateState.js';
import { optionPrice } from '../../components/ui.jsx';
import { num } from '../../lib/format.js';

// Everything that costs money EVERY month: central-station monitoring, the Alarm.com
// package, ConnectOne, AlarmNet, access hosting, the communicator and certificate
// line items, and whatever someone typed in the free row.
//
// The sibling of useOneTimeWork, and for the same reason — QuoteBuilder was 762 lines
// after the one-time half was mounted, and the rule in CLAUDE.md exists because the
// thing this project replaces is one 16,000-line file. A tab that owns nine pieces of
// monitoring state and four derived totals is how that starts again.
//
// The output is ONE NUMBER, `total`, which is what calc.js computeQuote takes as
// `monthlyCosts` — the legacy's COST_IDS sum (:3491, :4242).

export function useMonthlyCosts(rates, { systemType, isCommercial, city } = {}) {
  const [gcsChecks, setGcsChecks] = useState({ fire: false, burg: false, res: false });
  const [adcEnabled, setAdcEnabled] = useState(false);
  const [adcCfg, setAdcCfg] = useState(newAdcState);
  const [connectOne, setConnectOne] = useState({ enabled: false, systems: 1, addon: false, sms: '' });
  const [alarmNet, setAlarmNet] = useState({ enabled: false, plan: '' });
  const [accessHosting, setAccessHosting] = useState('');
  const [checks, setChecks] = useState({ honeywell: false, teleguard: false, br: false, sfburg: false, ulcerts: false, bosch: false });
  const [boschAmt, setBoschAmt] = useState('');
  const [customMon, setCustomMon] = useState({ desc: '', cost: '' });

  const options = rates?.dropdownOptions || {};
  const misc = rates?.misc || {};

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

  // Alarm.com — priced by src/lib/adc.js, which npm run parity:adc checks against the
  // legacy across 6,048 combinations, through the SAME conversion the panel uses.
  const adcPriced = useMemo(() => computeAdc(adcInputFrom(adcCfg), rates || {}), [adcCfg, rates]);
  const adcTotal = adcEnabled ? adcPriced.total : 0;

  // ConnectOne — legacy :3692-3699
  const connectOneTotal = useMemo(() => {
    if (!connectOne.enabled) return 0;
    const systems = Math.max(1, num(connectOne.systems) || 1);
    const base = (Number(rates?.monitoring?.BaseRate) || 0) * systems;
    const addon = connectOne.addon ? (Number(rates?.monitoring?.AddonRate) || 0) * systems : 0;
    return base + addon + optionPrice(options, 'connectone-sms', connectOne.sms);
  }, [connectOne, rates, options]);

  const alarmNetTotal = alarmNet.enabled ? optionPrice(options, 'alarmnet-plan', alarmNet.plan) : 0;
  const sfBurgRate = isCommercial ? Number(rates?.gcs?.SfBurgCommercial) || 0 : Number(rates?.gcs?.SfBurgResidential) || 0;
  const isSF = /san francisco/i.test(city || '');

  // Fixed "Other monthly" rates come from the rate profile (MiscRate keys) — in the
  // legacy these were hardcoded in the HTML onchange handlers (:1861-1863), so a price
  // change needed a deploy.
  const rate = {
    honeywell: Number(misc.honeywellComm) || 0,
    teleguard: Number(misc.telguardComm) || 0,
    br: Number(misc.buildingReports) || 0,
    ulcerts: Number(misc.ulCerts) || 0,
    sfburg: sfBurgRate,
  };

  const total =
    gcs + adcTotal + connectOneTotal + alarmNetTotal + num(accessHosting)
    + (checks.honeywell ? rate.honeywell : 0)
    + (checks.teleguard ? rate.teleguard : 0)
    + (checks.br ? rate.br : 0)
    + (checks.sfburg ? rate.sfburg : 0)
    + (checks.ulcerts ? rate.ulcerts : 0)
    + (checks.bosch ? num(boschAmt) : 0)
    + num(customMon.cost);

  const clear = () => {
    setGcsChecks({ fire: false, burg: false, res: false });
    setAdcEnabled(false);
    setAdcCfg(newAdcState());
    setConnectOne({ enabled: false, systems: 1, addon: false, sms: '' });
    setAlarmNet({ enabled: false, plan: '' });
    setAccessHosting('');
    setChecks({ honeywell: false, teleguard: false, br: false, sfburg: false, ulcerts: false, bosch: false });
    setBoschAmt('');
    setCustomMon({ desc: '', cost: '' });
  };

  return {
    gcsChecks, setGcsChecks,
    adcEnabled, setAdcEnabled, adcCfg, setAdcCfg,
    connectOne, setConnectOne,
    alarmNet, setAlarmNet,
    accessHosting, setAccessHosting,
    checks, setChecks,
    boschAmt, setBoschAmt,
    customMon, setCustomMon,
    gcs, adcTotal, connectOneTotal, alarmNetTotal, rate, isSF,
    total, clear,
  };
}
