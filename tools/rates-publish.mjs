#!/usr/bin/env node
// Publish a rate file as a new active rate profile.
//
//   npm run rates:publish                          dry run
//   npm run rates:publish -- --commit
//   npm run rates:publish -- --commit --i-am-loading-production=<host>
//
// A NEW VERSION, ALWAYS. The active profile is never edited: every quote pins the
// rate_profile_id it was priced against, so rewriting one in place would silently
// change what past quotes claim they were priced from. Publishing supersedes; it does
// not overwrite.
//
// That also makes this reversible. Rolling back is publishing the previous file again,
// which is a diff someone can read, rather than a restore.
//
// WHO RUNS IT. Ideally nobody by hand — .github/workflows/publish-rates.yml runs it
// when db/rates/*.json changes on development or production, so a rate change is a
// reviewed pull request with an author and a reason. The command exists for
// emergencies and for the first load.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { publishProfile, validateProfile } from './lib/rate-profile.mjs';

const say = (m) => console.log(`  ${m}`);
const die = (m) => { console.error(`\n  ${m}\n`); process.exit(1); };

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const val = (n2, d) => { const i = argv.indexOf(`--${n2}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PROD_ACK = (argv.find((a) => a.startsWith('--i-am-loading-production=')) || '').split('=')[1];
const FILE = resolve(val('file', 'db/rates/sse.json'));
const BY = val('by', process.env.GITHUB_ACTOR || process.env.USERNAME || 'rates-publish');

if (!existsSync(FILE)) die(`No rate file at ${FILE}.\n\n  Generate one from a live profile:\n      npm run rates:export`);
const profile = JSON.parse(readFileSync(FILE, 'utf8'));
const TAG = profile.productTag || 'sse';

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
const isProd = /(^|[-._])prod(uction)?([-._]|$)/i.test(cfg.host);

if (isProd && COMMIT && PROD_ACK !== cfg.host) {
  die(`"${cfg.host}" is PRODUCTION.\n\n` +
      `  Dry run needs no flag and shows the full diff. To publish:\n` +
      `      npm run rates:publish -- --commit --i-am-loading-production=${cfg.host}`);
}

// Sections without which the app prices at zero rather than failing -- the whole class
// of bug this repo spent a day removing.
const problems = validateProfile(profile);
if (problems.length) die(`${FILE} cannot be published:\n` + problems.map((x) => `      - ${x}`).join('\n'));

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

  console.log('');
  say(`file   : ${FILE}`);
  say(`target : ${cfg.host}/${cfg.database}  (product '${TAG}')`);
  say(`mode   : ${COMMIT ? 'COMMIT — publishes a new active version' : 'DRY RUN — rolled back at the end'}`);
  console.log('');

  await client.query('BEGIN');
  try {
    // THE SAME publish the round-trip harness exercises.
    const { version, previousVersion } = await publishProfile(client, profile, BY);

    say(`${previousVersion ? `v${previousVersion} -> ` : ''}v${version} published by ${BY}`);
    say(`  ${(profile.pricingOptions || []).length} option(s), ${(profile.tiers || []).length} tier(s), ` +
        `${Object.keys(profile.misc || {}).length} misc, Alarm.com sheet ${profile.adc ? 'present' : 'ABSENT'}`);

    if (COMMIT) { await client.query('COMMIT'); console.log(''); say('COMMITTED. The previous version is retained and still referenced by past quotes.'); }
    else { await client.query('ROLLBACK'); console.log(''); say('DRY RUN — rolled back.'); }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
  console.log('');
}

main().catch((err) => die(`Publish failed: ${err.message}`));
