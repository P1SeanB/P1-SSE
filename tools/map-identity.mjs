#!/usr/bin/env node
// Point imported records at a real Entra identity.
//
//   npm run migrate:identity -- --from supabase:<uuid> --to <entra-object-id>
//   ...add --commit to write
//
// The import writes 'supabase:<uuid>' for every legacy author, because a Supabase
// UUID and an Entra object id cannot be resolved to each other without a person
// deciding who is who. That placeholder is deliberately unmistakable — the failure
// worth engineering against is a plausible-looking id that quietly belongs to nobody.
// This is the step that replaces it.
//
// Updates all three tables that carry an author, because a request whose owner is
// mapped while its notes and attachments still point at the placeholder is worse than
// either state on its own: it looks finished.
//
// Optional --name and --email overwrite the display fields. Worth passing: the legacy
// stored whatever the person typed into Supabase ('sean.bithell'), and the Entra
// display name is what everyone else in the app is shown as.
import { readFileSync, existsSync } from 'node:fs';
import pg from 'pg';

const say = (m) => console.log(`  ${m}`);
const die = (m) => { console.error(`\n  ${m}\n`); process.exit(1); };

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const val = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const PROD_ACK = (argv.find((a) => a.startsWith('--i-am-loading-production=')) || '').split('=')[1];

const FROM = val('from');
const TO = val('to');
const NAME = val('name');
const EMAIL = val('email');

if (!FROM || !TO) {
  die('Both --from and --to are required.\n\n' +
      '      npm run migrate:identity -- --from supabase:<uuid> --to <entra-object-id>\n\n' +
      '  Find the placeholders with:\n' +
      "      SELECT DISTINCT requester_oid FROM change_request WHERE requester_oid LIKE 'supabase:%';");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A typo here writes a valid-looking id that belongs to nobody — exactly the state the
// placeholder exists to avoid — and nothing downstream would notice.
if (!UUID.test(TO)) die(`--to "${TO}" is not an object id. Pass the Entra objectId, not an appId or a UPN.`);
if (UUID.test(FROM)) {
  die(`--from "${FROM}" looks like a bare uuid. The imported value includes its prefix:\n      --from supabase:${FROM}`);
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
      `  Dry run needs no flag. To write, echo the host back:\n` +
      `      npm run migrate:identity -- --from ${FROM} --to ${TO} --commit --i-am-loading-production=${cfg.host}`);
}

const TABLES = [
  ['change_request', 'requester_oid', 'requester_name', 'requester_email'],
  ['change_request_note', 'author_oid', 'author_name', 'author_email'],
  ['change_request_file', 'uploaded_by_oid', 'uploaded_by_name', null],
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

  console.log('');
  say(`target : ${cfg.host}/${cfg.database}`);
  say(`from   : ${FROM}`);
  say(`to     : ${TO}${NAME ? `  (${NAME})` : ''}`);
  say(`mode   : ${COMMIT ? 'COMMIT' : 'DRY RUN — rolled back at the end'}`);
  console.log('');

  await client.query('BEGIN');
  try {
    let total = 0;
    for (const [table, oidCol, nameCol, emailCol] of TABLES) {
      const sets = [`${oidCol} = $1`];
      const params = [TO, FROM];
      if (NAME) { sets.push(`${nameCol} = $${params.length + 1}`); params.push(NAME); }
      if (EMAIL && emailCol) { sets.push(`${emailCol} = $${params.length + 1}`); params.push(EMAIL); }
      const r = await client.query(
        `UPDATE ${table} SET ${sets.join(', ')} WHERE ${oidCol} = $2`, params,
      );
      say(`${table.padEnd(22)} ${r.rowCount} row(s)`);
      total += r.rowCount;
    }

    // What is left, so the report is about the DATABASE rather than about this run.
    const left = await client.query(
      `SELECT count(DISTINCT requester_oid) AS n FROM change_request WHERE requester_oid LIKE 'supabase:%'`,
    );
    console.log('');
    say(`${total} row(s) updated; ${left.rows[0].n} distinct placeholder identity/identities remain`);

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

main().catch((err) => die(`Mapping failed: ${err.message}`));
