#!/usr/bin/env node
// Rebind a PostgreSQL role to a recreated Azure identity.
//
//   PGHOST=<shared-server-fqdn> PGUSER=<your-entra-admin-upn> \
//     node tools/pg-rebind-role.mjs --app p1sse-api-dev --oid <new-principal-id>
//
//   --check   report the current binding, change nothing
//
// WHY THIS EXISTS. An Entra-backed PostgreSQL role is bound to the identity's OBJECT
// ID, not its name. Delete and recreate a Function App and the name is identical while
// the object id is new, so the role survives looking perfectly healthy — the grants
// are real, the isolation matrix reads correctly — and every connection fails with:
//
//   Service principal oid mismatch for role "The oid in the security label [old] does
//   not match the appid [...] or oid [new] in the token."
//
// grant-roles.mjs cannot fix it. That script creates a role when absent and grants
// privileges when present; by both tests a stale role is fine, and the one thing wrong
// is invisible to it. Hence a separate, explicit operation.
//
// It rebinds IN PLACE via pgaadauth_update_principal_with_oid. An earlier draft of
// this dropped and recreated the role, which would have silently discarded every
// grant — the privileges are attached to the role, not to the binding. Rebinding keeps
// them, so nothing has to be re-applied afterwards.
//
// The pgaadauth functions live in the `postgres` database, not in the app's database,
// which is why this connects there regardless of which database the role is used in.
// The binding is server-wide: one rebind covers every database the role can reach.
import pg from 'pg';

const say = (m) => console.log(`  ${m}`);
const die = (m) => { console.error(`\n  ${m}\n`); process.exit(1); };

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const CHECK = argv.includes('--check');
const appName = flag('app');
const newOid = flag('oid');

if (!appName) {
  die('Pass --app <role-name>. Example:\n' +
      '      node tools/pg-rebind-role.mjs --app p1sse-api-dev --check');
}

const host = process.env.PGHOST;
const admin = process.env.PGUSER;
if (!host) die('PGHOST is not set (the shared server FQDN).');
if (!admin) die('PGUSER is not set (your Entra admin UPN).');

// The binding is server-wide, so a mistake here reaches every database on the server,
// including two other applications'.
if (/(^|[-._])prod(uction)?([-._]|$)/i.test(host)) {
  die(`REFUSING: "${host}" looks like PRODUCTION. Rebind there deliberately, not by habit.`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (newOid && !UUID.test(newOid)) die(`"${newOid}" is not an object id.`);

async function main() {
  const { DefaultAzureCredential } = await import('@azure/identity');
  const token = await new DefaultAzureCredential()
    .getToken('https://ossrdbms-aad.database.windows.net/.default');
  if (!token) throw new Error('No Entra token. Run: az login');

  const client = new pg.Client({
    host, port: Number(process.env.PGPORT || 5432), database: 'postgres',
    user: admin, password: token.token, ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 30_000,
  });
  await client.connect();
  say(`connected to ${host}/postgres as ${admin}`);

  const { rows } = await client.query(
    'SELECT rolname, principaltype, objectid FROM pgaadauth_list_principals(false) WHERE rolname = $1',
    [appName],
  );
  if (!rows.length) {
    await client.end();
    die(`"${appName}" is not a registered Entra principal on this server.\n` +
        `  Create it with: node scripts/grant-roles.mjs --app ${appName} --db <db>`);
  }

  const current = rows[0];
  say(`role "${appName}" (${current.principaltype}) is bound to: ${current.objectid}`);

  if (CHECK || !newOid) {
    await client.end();
    console.log('');
    if (!newOid && !CHECK) say('No --oid given, so nothing was changed.');
    say('Compare with the identity Azure reports:');
    say(`    az functionapp show -n ${appName} -g <resource-group> --query identity.principalId -o tsv`);
    say(`If they differ:  node tools/pg-rebind-role.mjs --app ${appName} --oid <that-id>`);
    console.log('');
    return;
  }

  if (current.objectid === newOid) {
    await client.end();
    console.log('');
    say('Already bound to that object id — nothing to do.');
    console.log('');
    return;
  }

  await client.query('SELECT pgaadauth_update_principal_with_oid($1, $2, $3, false, false)',
    [appName, newOid, current.principaltype || 'service']);

  const after = await client.query(
    'SELECT objectid FROM pgaadauth_list_principals(false) WHERE rolname = $1',
    [appName],
  );
  const bound = after.rows[0]?.objectid;
  await client.end();

  console.log('');
  if (bound === newOid) {
    say(`rebound "${appName}": ${current.objectid} -> ${bound}`);
    say('Grants are untouched — the role kept them. No need to re-run grant-roles.');
  } else {
    say(`REBIND DID NOT TAKE. Still bound to ${bound}.`);
    process.exitCode = 1;
  }
  console.log('');
}

main().catch((err) => die(`Rebind failed: ${err.message}`));
