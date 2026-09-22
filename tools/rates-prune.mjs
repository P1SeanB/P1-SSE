#!/usr/bin/env node
// Delete superseded rate profile versions.
//
//   npm run rates:prune -- --keep 2                 dry run
//   npm run rates:prune -- --keep 2 --commit
//   npm run rates:prune -- --versions 3,4,5 --commit
//
// --keep N   keep the active profile and the N most recent others
// --versions explicit list, for removing specific ones
//
// WHY A TOOL RATHER THAN A DELETE STATEMENT. A rate profile is what a quote says it
// was priced against. Deleting one that a quote references would leave that quote
// unable to explain its own numbers — and the foreign key would either block the
// delete or, if someone reached for ON DELETE CASCADE, take the quote with it.
//
// So this REFUSES to delete any profile a quote references, and says which. That check
// is the entire reason it exists; the deleting part is three lines.
//
// The ACTIVE profile is never deletable. Removing it would leave the app with no rates
// at all, and /api/rates would 404 rather than fail in a way anyone could read.
import { readFileSync, existsSync } from 'node:fs';
import pg from 'pg';

const say = (m) => console.log(`  ${m}`);
const die = (m) => { console.error(`\n  ${m}\n`); process.exit(1); };

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const val = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PROD_ACK = (argv.find((a) => a.startsWith('--i-am-loading-production=')) || '').split('=')[1];
const KEEP = val('keep') !== undefined ? Number(val('keep')) : undefined;
const VERSIONS = val('versions') ? val('versions').split(',').map((v) => Number(v.trim())) : undefined;
const TAG = val('tag', 'sse');

if (KEEP === undefined && !VERSIONS) {
  die('Pass --keep <n> or --versions <list>.\n\n' +
      '      npm run rates:prune -- --keep 2\n' +
      '      npm run rates:prune -- --versions 3,4,5');
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
const isProd = /(^|[-._])prod(uction)?([-._]|$)/i.test(cfg.host);

if (isProd && COMMIT && PROD_ACK !== cfg.host) {
  die(`"${cfg.host}" is PRODUCTION.\n\n` +
      `  Deleting rate history there removes what past quotes were priced against.\n` +
      `  To proceed anyway, echo the host back:\n` +
      `      npm run rates:prune -- ... --commit --i-am-loading-production=${cfg.host}`);
}

// Every table that hangs off a rate profile. Missing one would leave orphans the
// foreign key then blocks, reported as a constraint error rather than as "this tool is
// incomplete".
const CHILDREN = [
  'labor_rate', 'service_call_rate', 'monitoring_rate', 'door_rate', 'video_rate',
  'gcs_rate', 'min_rmr_rate', 'misc_rate', 'tier_rate', 'door_bundle', 'pricing_option',
];

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

  const { rows } = await client.query(
    `SELECT rp.rate_profile_id id, rp.version, rp.is_active, rp.created_by,
            (SELECT count(*) FROM quote q WHERE q.rate_profile_id = rp.rate_profile_id) AS quotes
       FROM rate_profile rp JOIN product p ON p.product_id = rp.product_id
      WHERE p.tag = $1 ORDER BY rp.version`, [TAG],
  );
  if (!rows.length) { await client.end(); die(`No rate profiles for '${TAG}' on ${cfg.host}.`); }

  const active = rows.find((r) => r.is_active);
  let doomed;
  if (VERSIONS) {
    doomed = rows.filter((r) => VERSIONS.includes(Number(r.version)));
    const unknown = VERSIONS.filter((v) => !rows.some((r) => Number(r.version) === v));
    if (unknown.length) die(`No such version(s): ${unknown.join(', ')}`);
  } else {
    const inactive = rows.filter((r) => !r.is_active).sort((a, b) => b.version - a.version);
    doomed = inactive.slice(KEEP);
  }

  // Never the active one, whatever was asked for.
  const askedForActive = doomed.some((r) => r.is_active);
  doomed = doomed.filter((r) => !r.is_active);

  // Never one a quote depends on.
  const referenced = doomed.filter((r) => Number(r.quotes) > 0);
  doomed = doomed.filter((r) => Number(r.quotes) === 0);

  console.log('');
  say(`target : ${cfg.host}/${cfg.database}  (product '${TAG}')`);
  say(`mode   : ${COMMIT ? 'COMMIT — deletes permanently' : 'DRY RUN — rolled back at the end'}`);
  console.log('');
  say('current profiles:');
  for (const r of rows) {
    const mark = r.is_active ? 'ACTIVE' : doomed.some((d) => d.id === r.id) ? 'DELETE' : 'keep  ';
    say(`  v${String(r.version).padEnd(3)} ${mark}  ${String(r.quotes).padStart(3)} quote(s)  ${r.created_by}`);
  }

  if (askedForActive) { console.log(''); say(`refused: v${active.version} is ACTIVE. Publish another version first.`); }
  if (referenced.length) {
    console.log('');
    say(`refused ${referenced.length}: quotes reference them and would lose the rates they were priced against —`);
    for (const r of referenced) say(`  v${r.version}: ${r.quotes} quote(s)`);
  }

  if (!doomed.length) { console.log(''); say('Nothing to delete.'); console.log(''); await client.end(); return; }

  await client.query('BEGIN');
  try {
    const ids = doomed.map((d) => d.id);
    let removed = 0;
    for (const table of CHILDREN) {
      const r = await client.query(`DELETE FROM ${table} WHERE rate_profile_id = ANY($1::int[])`, [ids]);
      removed += r.rowCount;
    }
    const p = await client.query('DELETE FROM rate_profile WHERE rate_profile_id = ANY($1::int[])', [ids]);

    console.log('');
    say(`deleted ${p.rowCount} profile(s) (v${doomed.map((d) => d.version).join(', v')}) and ${removed} child row(s)`);

    if (COMMIT) { await client.query('COMMIT'); console.log(''); say('COMMITTED.'); }
    else { await client.query('ROLLBACK'); console.log(''); say('DRY RUN — rolled back.'); }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
  console.log('');
}

main().catch((err) => die(`Prune failed: ${err.message}`));
