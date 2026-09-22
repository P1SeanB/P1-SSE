#!/usr/bin/env node
// Does a rate file survive being published and read back?
//
//   npm run parity:rates
//
// THE RISK. db/rates/sse.json becomes the only way anyone changes a rate after
// cutover. If publish and export disagree about even one field — a column publish
// drops, a numeric that comes back a string, an option whose order shifts — then
// editing the file does not produce the rates you read, and the difference is a price
// nobody notices.
//
// It runs THE REAL publish and THE REAL read, imported from tools/lib/rate-profile.mjs
// rather than reimplemented here. An earlier version of this file carried its own copy
// of the inserts, which proved only that the harness agreed with itself — the same
// blind spot that already hid three faults in this codebase: a fixture shaped unlike
// the API's response, add-ons compared as dollar amounts on both sides, and an adc
// tree the endpoint never returned.
//
// Everything happens inside a transaction that is rolled back.
//
// SKIPS rather than fails when no database is reachable: a developer without Azure
// access should not be blocked by a check they cannot run, and CI has one.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { publishProfile, readProfile, validateProfile } from './lib/rate-profile.mjs';

const FILE = resolve('db/rates/sse.json');
if (!existsSync(FILE)) {
  console.log('\n  rate round trip: SKIPPED — db/rates/sse.json does not exist yet\n');
  process.exit(0);
}

const SETTINGS = 'api/local.settings.json';
const values = existsSync(SETTINGS) ? (JSON.parse(readFileSync(SETTINGS, 'utf8')).Values || {}) : {};
const cfg = {
  host: process.env.PGHOST || values.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || values.PGPORT || 5432),
  database: process.env.PGDATABASE || values.PGDATABASE || 'sse',
  user: process.env.PGUSER || values.PGUSER || 'sse',
  password: process.env.PGPASSWORD || values.PGPASSWORD || undefined,
};
const isAzure = /\.postgres\.database\.azure\.com$/i.test(cfg.host);

// Never against production, even rolled back. A transaction holding write locks on the
// live rate tables is not worth a test result.
if (/(^|[-._])prod(uction)?([-._]|$)/i.test(cfg.host)) {
  console.log(`\n  rate round trip: SKIPPED — refusing to run against production (${cfg.host})\n`);
  process.exit(0);
}

const profile = JSON.parse(readFileSync(FILE, 'utf8'));

async function password() {
  if (cfg.password) return cfg.password;
  const { DefaultAzureCredential } = await import('@azure/identity');
  const token = await new DefaultAzureCredential()
    .getToken('https://ossrdbms-aad.database.windows.net/.default');
  if (!token) throw new Error('no token');
  return token.token;
}

async function main() {
  const failures = validateProfile(profile).map((p) => `the file is invalid: ${p}`);

  let client;
  try {
    client = new pg.Client({
      ...cfg, password: await password(),
      ssl: isAzure ? { rejectUnauthorized: true } : false,
      connectionTimeoutMillis: 15_000,
    });
    await client.connect();
  } catch (err) {
    console.log(`\n  rate round trip: SKIPPED — no database reachable (${err.message})\n`);
    process.exit(0);
  }

  await client.query('BEGIN');
  try {
    const { rateProfileId } = await publishProfile(client, profile, 'parity');
    const back = await readProfile(client, rateProfileId, profile.productTag || 'sse', profile.exportedFromVersion);

    const compare = (label, got, want) => {
      const a = JSON.stringify(got);
      const b = JSON.stringify(want);
      if (a !== b) {
        failures.push(
          `${label} changed through the round trip\n` +
          `      file: ${b.length > 150 ? b.slice(0, 150) + '…' : b}\n` +
          `      db  : ${a.length > 150 ? a.slice(0, 150) + '…' : a}`,
        );
      }
    };

    for (const key of ['labor', 'serviceCall', 'monitoring', 'door', 'video', 'gcs', 'minRmr']) {
      compare(key, back[key], profile[key]);
    }
    compare('tiers', back.tiers, profile.tiers);
    compare('doorBundles', back.doorBundles, profile.doorBundles);
    compare('pricingOptions', back.pricingOptions, profile.pricingOptions);
    // misc is read back sorted by key, so compare against the file sorted the same way
    // rather than reporting an ordering difference as a rate change.
    compare('misc', back.misc, Object.fromEntries(Object.entries(profile.misc || {}).sort(([a], [b]) => a.localeCompare(b))));
    compare('adc', back.adc, profile.adc);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }

  console.log(`\n  rate round trip: ${(profile.pricingOptions || []).length} option(s) + every rate table, through the real publish`);
  if (failures.length) {
    console.log(`\n  ${failures.length} PROBLEM(S):`);
    for (const f of failures) console.log(`    - ${f}`);
    console.log('');
    process.exit(1);
  }
  console.log('  No drift. The file publishes to exactly what it says.\n');
}

main().catch((err) => { console.error(`\n  round trip failed: ${err.message}\n`); process.exit(1); });
