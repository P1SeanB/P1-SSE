#!/usr/bin/env node
// Deep comparison of the port against the legacy page.
//
//   node tools/legacy-scan.mjs
//
// tools/coverage.mjs answers "is every legacy control accounted for" and says 375/375.
// That has now been wrong three times in ways it structurally cannot see: a control can
// be present, wired, and reading from a source that does not exist. So this looks at
// the seams between code and data instead of at the controls.
//
// It reports, it does not judge — several findings here are expected and explained in
// the output rather than silently filtered, because a scan that hides its reasoning is
// one you have to redo by hand.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const LEGACY = 'legacy/index.html';
const legacy = readFileSync(LEGACY, 'utf8');

// ── Gather source files ─────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|jsx)$/.test(p)) out.push(p);
  }
  return out;
}
const srcFiles = walk('src');
const srcText = srcFiles.map((f) => ({ file: f, text: readFileSync(f, 'utf8') }));
const allSrc = srcText.map((s) => s.text).join('\n');

// ── The exported rate config ────────────────────────────────────────────────
const exportDir = existsSync('migration-data')
  ? readdirSync('migration-data').filter((d) => existsSync(join('migration-data', d, 'app_rates.json'))).sort().pop()
  : null;
let cfg = null;
if (exportDir) {
  const raw = JSON.parse(readFileSync(join('migration-data', exportDir, 'app_rates.json'), 'utf8'))[0].config;
  cfg = typeof raw === 'string' ? JSON.parse(raw) : raw;
}

const section = (t) => console.log(`\n${'='.repeat(74)}\n${t}\n${'='.repeat(74)}`);
const findings = [];
const note = (severity, what) => { findings.push({ severity, what }); console.log(`  [${severity}] ${what}`); };

// ── 1. Dropdown groups: referenced vs available ─────────────────────────────
section('1. DROPDOWN GROUPS — does every group the app asks for have data?');

const askedGroups = new Set();
for (const { text } of srcText) {
  for (const m of text.matchAll(/['"]((?:adc|alarmnet|connectone|sla)-[a-zA-Z0-9-]+)['"]/g)) askedGroups.add(m[1]);
}
const htmlGroups = new Set(Object.keys(cfg?.dropdownsHTML || {}));

// Where the legacy builds a control's options from the adc tree rather than from
// dropdownsHTML. Those groups are SUPPOSED to be absent from the markup blocks.
const FROM_ADC_TREE = {
  'adc-addons': 'adc.addOns[].prices — fixed to resolve by id per package',
  'adc-flexio': 'adc.tiers.flexIO (max/step/perUnit)',
  'adc-cellconnector': 'adc.tiers.cellConnectorV20',
  'adc-verizon-data': 'adc.tiers.verizonDataGB',
  'adc-img-events': 'adc.tiers.imageSensorEvents',
  'adc-aid': 'adc.aidPerBlock / aidBlockEvents / aidMaxBlocks',
  'adc-access-bundle': 'doorBundlesStd  -> door_bundle table',
  'adc-access-bundle-sacp': 'doorBundlesSACP -> door_bundle table',
};

for (const g of [...askedGroups].sort()) {
  if (htmlGroups.has(g)) continue;
  if (FROM_ADC_TREE[g]) {
    console.log(`  ok   ${g.padEnd(24)} not markup — sourced from ${FROM_ADC_TREE[g]}`);
  } else {
    note('CHECK', `${g} is referenced in src but is neither a dropdownsHTML block nor a known adc-tree source`);
  }
}
for (const g of [...htmlGroups].sort()) {
  if (!askedGroups.has(g)) note('UNUSED', `${g} exists in the legacy rate data but nothing in src references it`);
}

// ── 2. Legacy element ids the port never mentions ───────────────────────────
section('2. LEGACY CONTROLS — ids present in the legacy page and absent from src');

// ONLY ids on real form controls. An earlier version of this took every id on the
// page and reported 319 "gaps", nearly all of them containers, totals, field wrappers
// and button icons — a number big enough to look alarming and too noisy to act on. A
// control is something a person types into or picks from.
const legacyIds = new Set();
for (const m of legacy.matchAll(/<(input|select|textarea)\b[^>]*\bid="([a-zA-Z][\w-]{2,})"/gi)) {
  legacyIds.add(m[2]);
}

const coverage = existsSync('tools/port-coverage.json')
  ? JSON.parse(readFileSync('tools/port-coverage.json', 'utf8')) : {};

// Ids that are page furniture rather than controls: containers, labels, value spans.
const FURNITURE = /^(lbl-|val-|row-|sec-|hdr-|tbl-|wrap|p1cr-|.*-(label|value|wrap|container|panel|body|head|list|hint|help|note|err|msg)$)/i;

let unmapped = 0;
const unmappedIds = [];
for (const id of [...legacyIds].sort()) {
  if (FURNITURE.test(id)) continue;
  const inCoverage = Object.prototype.hasOwnProperty.call(coverage, id);
  const inSrc = allSrc.includes(id);
  if (!inCoverage && !inSrc) { unmapped++; unmappedIds.push(id); }
}
if (unmapped === 0) console.log('  ok   every non-furniture legacy id is either mapped in coverage or named in src');
else {
  console.log(`  ${unmapped} legacy id(s) appear in neither coverage nor src:`);
  for (const id of unmappedIds.slice(0, 40)) console.log(`       ${id}`);
  if (unmappedIds.length > 40) console.log(`       ... and ${unmappedIds.length - 40} more`);
  note('CHECK', `${unmapped} legacy id(s) unaccounted for — listed above`);
}

// ── 3. Whole features, not controls ─────────────────────────────────────────
section('3. FEATURES — capabilities the legacy has, by evidence in the port');

// Each entry: what it is, how to detect it in the legacy, how to detect it in src.
const FEATURES = [
  ['Save/export a .p1est estimate file', /\.p1est|p1estExport|saveEstimate/i, /\.p1est|exportEstimate|downloadEstimate/i],
  ['Load/import a .p1est file', /importEstimate|loadEstimate|readAsText/i, /importEstimate|loadEstimate|FileReader/i],
  ['Generate the SLA document', /slaDoc|generateSla|buildSla/i, /SlaCreator|slaDoc|generateSla/i],
  ['Print / PDF output', /window\.print|jsPDF|printSection/i, /window\.print|jsPDF|printSection/i],
  ['Bill of materials export (CSV)', /bomCsv|exportBom|csvEscape/i, /BomExport|bomCsv|exportBom/i],
  ['Change requests', /cr_requests|p1cr-submit/i, /ChangeRequests|change-requests/i],
  ['Monitoring contracts', /monitoringContract|mc-tab|contracts/i, /MonitoringContracts/i],
  ['Customer / site records', /customers|siteList/i, /customers|CustomerInfo|sites/i],
  ['Vendor material import (spreadsheet paste)', /parsePaste|vendorParse|pasteRows/i, /parsePaste|MaterialRows|pasteRows/i],
];

for (const [name, legacyRe, srcRe] of FEATURES) {
  const inLegacy = legacyRe.test(legacy);
  const inSrc = srcRe.test(allSrc);
  if (!inLegacy) { console.log(`  n/a  ${name} — not detected in the legacy either`); continue; }
  if (inSrc) console.log(`  ok   ${name}`);
  else note('MISSING', `${name} — present in the legacy, no evidence in src`);
}

// ── 4. Rate keys the legacy config carries that nothing reads ───────────────
section('4. RATE KEYS — config values the port never consumes');

if (cfg) {
  const scalarKeys = Object.entries(cfg)
    .filter(([, v]) => typeof v === 'number')
    .map(([k]) => k);
  const unread = scalarKeys.filter((k) => !allSrc.includes(k) && !readFileSync('tools/supabase-import.mjs', 'utf8').includes(k));
  if (!unread.length) console.log('  ok   every scalar rate in the config is read somewhere');
  else for (const k of unread) note('UNREAD', `config.${k} = ${cfg[k]} is imported nowhere and read nowhere`);
} else {
  console.log('  skipped — no export found under migration-data/');
}

// ── Summary ─────────────────────────────────────────────────────────────────
section('SUMMARY');
if (!findings.length) {
  console.log('  Nothing outstanding.\n');
} else {
  const by = {};
  for (const f of findings) (by[f.severity] ||= []).push(f.what);
  for (const [sev, items] of Object.entries(by)) {
    console.log(`\n  ${sev} (${items.length}):`);
    for (const i of items) console.log(`    - ${i}`);
  }
  console.log('');
}
