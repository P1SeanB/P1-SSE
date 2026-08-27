#!/usr/bin/env node
// Write the active rate profile out to a file.
//
//   npm run rates:export                    from whatever PGHOST points at
//   npm run rates:export -- --out db/rates/sse.json
//
// The file this produces is the INPUT to rates:publish, and the two are meant to round
// trip: export, publish, export again, and the second file should equal the first.
// tools/parity-rates-roundtrip.mjs asserts exactly that.
//
// WHY A FILE AT ALL. After cutover there is no other way to change a rate. The legacy
// kept them in Supabase, where Sean edited a table directly; the new app only READS
// rates. A file in the repository means a rate change is a reviewed diff with an
// author and a reason attached, rather than someone editing production data at the
// moment they most want to hurry.
//
// It is generated, never hand-written. Transcribing 291 dropdown options and a 40KB
// vendor price sheet by hand is how a decimal point moves.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { readProfile } from './lib/rate-profile.mjs';

const say = (m) => console.log(`  ${m}`);
const die = (m) => { console.error(`\n  ${m}\n`); process.exit(1); };

const argv = process.argv.slice(2);
const val = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = resolve(val('out', 'db/rates/sse.json'));
const TAG = val('tag', process.env.PRODUCT_TAG || 'sse');

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

async function password() {
  if (cfg.password) return cfg.password;
  const { DefaultAzureCredential } = await import('@azure/identity');
  const token = await new DefaultAzureCredential()
    .getToken('https://ossrdbms-aad.database.windows.net/.default');
  if (!token) throw new Error('No Entra token. Run: az login');
  return token.token;
}

async function main() {
  const client = new pg.Client({
    ...cfg, password: await password(),
    ssl: isAzure ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 30_000,
  });
  await client.connect();

  const active = await client.query(
    `SELECT rp.rate_profile_id, rp.version, rp.adc
       FROM rate_profile rp JOIN product p ON p.product_id = rp.product_id
      WHERE rp.is_active AND p.tag = $1`,
    [TAG],
  );
  if (!active.rowCount) { await client.end(); die(`No active rate profile for '${TAG}' on ${cfg.host}.`); }
  const { rate_profile_id: id, version, adc } = active.rows[0];

  // THE SAME reader the round-trip harness uses, so a field this export drops is a
  // field that check notices.
  const profile = await readProfile(client, id, TAG, version);
  profile.adc = adc || null;

  await client.end();

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(profile, null, 2) + '\n');

  console.log('');
  say(`exported v${version} for '${TAG}' from ${cfg.host}`);
  say(`  ${profile.pricingOptions.length} pricing option(s), ${profile.tiers.length} tier(s), ` +
      `${profile.doorBundles.length} door bundle(s), ${Object.keys(profile.misc).length} misc rate(s)`);
  say(`  Alarm.com sheet: ${adc ? 'present' : 'ABSENT'}`);
  say(`written to ${OUT.replace(process.cwd() + '\\', '').replace(process.cwd() + '/', '')}`);
  console.log('');
}

main().catch((err) => die(`Export failed: ${err.message}`));
