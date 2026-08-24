// PostgreSQL access for the Functions API.
//
// Replaces the mssql version. PostgreSQL rather than Azure SQL because the
// organisation already runs shared PostgreSQL Flexible Servers for the estimator
// and F.R.E.D — another database on them costs nothing marginal, and it reuses
// tooling already proven in production. See db/schema.pg.sql for the full reasoning.
//
// NO PASSWORD EXISTS. The server has password authentication disabled entirely; the
// Function App's managed identity gets an Entra access token and uses that as the
// PostgreSQL password. There is nothing to store, rotate, or leak, and no
// connection string in app settings — which is the main practical difference from
// the mssql version this replaces.
//
// Configuration (app settings, none of them secret):
//   PGHOST      the shared server FQDN
//   PGDATABASE  this app's database on it (default 'sse')
//   PGUSER      the Entra principal name of THIS app's managed identity, which is
//               also its PostgreSQL role name
//   PGPASSWORD  local development only — never set in Azure
import pg from 'pg';

const PG_AAD_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';

let pool;
let credential;

// Tokens last about an hour, and a Function App is long-lived, so a token fetched
// once at startup would expire mid-life and every later connection would fail
// authentication. node-postgres accepts an async `password`, which it calls per new
// connection — so expiry is handled by construction rather than by a refresh timer
// we would have to get right.
async function password() {
  if (process.env.PGPASSWORD) return process.env.PGPASSWORD;
  if (!credential) {
    const { DefaultAzureCredential } = await import('@azure/identity');
    credential = new DefaultAzureCredential();
  }
  const token = await credential.getToken(PG_AAD_SCOPE);
  if (!token) throw new Error('Could not acquire an Entra token for PostgreSQL.');
  return token.token;
}

export function getPool() {
  if (pool) return pool;

  const host = process.env.PGHOST;
  if (!host) {
    throw new Error(
      'PGHOST is not configured. Set it on the Static Web App ' +
        '(Configuration → Application settings), along with PGDATABASE and PGUSER.',
    );
  }

  pool = new pg.Pool({
    host,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'sse',
    user: process.env.PGUSER,
    password,
    // Small on purpose. Functions scale out by adding instances, each with its own
    // pool, and the shared server is Burstable with a modest max_connections that
    // three applications draw from. A generous pool here starves the others.
    max: Number(process.env.PGPOOL_MAX || 4),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true },
  });

  // Without a handler, an idle client erroring (a server restart, a dropped
  // connection) is an unhandled 'error' event, which takes the whole worker down
  // rather than failing one request.
  pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
  });

  return pool;
}

/**
 * Run a parameterised query. Always pass values as `params` — never interpolate
 * them into the SQL string.
 *
 *   const { rows } = await query('SELECT * FROM quote WHERE quote_id = $1', [id]);
 */
export async function query(text, params = []) {
  return getPool().query(text, params);
}

/**
 * Run several statements as one unit. Used by anything that writes a parent and its
 * children together — a quote and its line items, a change request and its files —
 * so a failure halfway cannot leave a half-saved record.
 */
export async function transaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
