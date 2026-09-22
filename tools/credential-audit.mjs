#!/usr/bin/env node
// Every Entra client secret in the tenant, and how long it has left.
//
//   npm run audit:credentials              report
//   npm run audit:credentials -- --days 90 change the warning threshold
//   npm run audit:credentials -- --ci      exit non-zero if anything is inside it
//
// WHY THIS EXISTS RATHER THAN A KEY VAULT CHANGE. Key Vault does NOT rotate an Entra
// app registration secret. It has managed rotation for storage account keys and for
// certificates it issues; an app secret is minted by Entra, and Key Vault can only
// hold a copy. Moving the secret into a vault improves where it lives — it stops being
// readable in app settings — but it does not stop it expiring.
//
// What stops an expiry outage is knowing before it happens. When one of these lapses
// the failure is a sign-in error that names a redirect or a token problem, not an
// expired credential, so it reads as an auth misconfiguration and gets debugged as
// one.
//
// This covers the WHOLE TENANT deliberately, not just P1-SSE. The first run found
// Vista Email Send and Inforcer Integration with 51 days left and nobody watching, and
// Switch Estimator carrying five separate secrets across two registrations — old ones
// that were never removed after a rotation, each still a live credential.
//
// Reads only. It lists credential METADATA — names and expiry dates. Secret values
// cannot be read back out of Entra by anyone, including this script.
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const WARN_DAYS = Number(flagValue('days', 90));
const CI = argv.includes('--ci');

// Windows needs cmd.exe here, and it is the only combination that works on Node 24.
// The az CLI is a .cmd, which Node 24 refuses to spawn directly (EINVAL); adding
// shell:true would run it but reintroduces DEP0190, which concatenates arguments
// without escaping — and one of these is a JMESPath query full of brackets and braces.
// Invoking cmd.exe (a real executable) with an argument ARRAY sidesteps both.
const RUNNER = process.platform === 'win32' ? 'cmd.exe' : 'az';
const prefix = process.platform === 'win32' ? ['/c', 'az'] : [];

const az = (args) => {
  try {
    return JSON.parse(execFileSync(RUNNER, [...prefix, ...args, '-o', 'json'], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    }) || 'null');
  } catch (err) {
    const msg = String(err.stderr || err.message).split('\n')[0];
    throw new Error(`az ${args.slice(0, 3).join(' ')} failed: ${msg}`);
  }
};

// Which app belongs to which project. Anything unmatched is still reported — a
// credential nobody claims is exactly the one that lapses unnoticed.
const OWNERS = [
  [/^P1-SSE/i, 'P1-SSE'],
  [/^F\.R\.E\.D/i, 'F.R.E.D'],
  [/^Switch Estimator/i, 'Switch Estimator'],
];
const ownerOf = (name) => (OWNERS.find(([re]) => re.test(name)) || [null, 'unclaimed'])[1];

console.log('\n  Reading app registrations…');
const apps = az(['ad', 'app', 'list', '--all', '--query', '[].{name:displayName,appId:appId}']);

const rows = [];
for (const app of apps) {
  let creds = [];
  try {
    creds = az(['ad', 'app', 'credential', 'list', '--id', app.appId,
      '--query', '[].{name:displayName,end:endDateTime}']) || [];
  } catch { continue; } // a registration this account cannot read is not a finding
  for (const c of creds) {
    const days = Math.floor((new Date(c.end) - Date.now()) / 86400000);
    rows.push({ app: app.name, owner: ownerOf(app.name), label: c.name || '(unnamed)', end: String(c.end).slice(0, 10), days });
  }
}

rows.sort((a, b) => a.days - b.days);

const expired = rows.filter((r) => r.days < 0);
const urgent = rows.filter((r) => r.days >= 0 && r.days < 30);
const soon = rows.filter((r) => r.days >= 30 && r.days < WARN_DAYS);

const line = (r) => `    ${String(r.days).padStart(5)}d  ${r.end}  ${r.owner.padEnd(18)} ${r.app}  [${r.label}]`;

console.log(`\n  ${rows.length} client secret(s) across ${new Set(rows.map((r) => r.app)).size} registration(s)\n`);

if (expired.length) { console.log(`  EXPIRED (${expired.length}):`); expired.forEach((r) => console.log(line(r))); console.log(''); }
if (urgent.length) { console.log(`  UNDER 30 DAYS (${urgent.length}):`); urgent.forEach((r) => console.log(line(r))); console.log(''); }
if (soon.length) { console.log(`  under ${WARN_DAYS} days (${soon.length}):`); soon.forEach((r) => console.log(line(r))); console.log(''); }

console.log('  all, soonest first:');
for (const r of rows) console.log(line(r));

// More than one live secret on a registration is usually a rotation that was never
// finished: the new secret was added, the app moved over, and the old one was left
// valid. It keeps working, which is why nobody notices.
const byApp = {};
for (const r of rows) (byApp[r.app] ||= []).push(r);
const multi = Object.entries(byApp).filter(([, v]) => v.length > 1);
if (multi.length) {
  console.log('\n  MORE THAN ONE LIVE SECRET (each is a working credential):');
  for (const [app, list] of multi) {
    console.log(`    ${app}: ${list.length} — ${list.map((r) => `${r.end} (${r.days}d)`).join(', ')}`);
  }
  console.log('    Remove the ones no longer in use: az ad app credential delete --id <appId> --key-id <id>');
}

console.log('\n  Rotating one:');
console.log('    az ad app credential reset --id <appId> --display-name "<what uses it>" --years 2 --append');
console.log('    --append keeps the current secret alive so the swap is not an outage.\n');

if (CI && (expired.length || urgent.length)) {
  console.error(`  FAILING: ${expired.length} expired, ${urgent.length} inside 30 days.\n`);
  process.exit(1);
}
