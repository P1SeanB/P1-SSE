// Exercises the SQL the handlers issue, against a real PostgreSQL engine.
//
// Not a substitute for a test suite — it is the check that the statements parse,
// the constraints behave, and the two pieces of non-obvious logic actually work:
// the optimistic-concurrency guard on quotes, and the status-change transaction on
// change requests. Both are the kind of thing that looks right and is wrong.
//
//   node api/src/_verify.mjs
//
// Creates a scratch database, runs, and drops it. Touches nothing else.
import pg from 'pg';
import { readFileSync } from 'node:fs';

const HOST = process.env.PGHOST || 'legac-estimator-postgres-dev.postgres.database.azure.com';
const USER = process.env.PGUSER || 'sniadmin@legac-group.com';
const SCRATCH = 'sse_verify_scratch';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  — ' + detail : ''}`); }
};

async function token() {
  if (process.env.PGPASSWORD) return process.env.PGPASSWORD;
  const { DefaultAzureCredential } = await import('@azure/identity');
  const t = await new DefaultAzureCredential().getToken(
    'https://ossrdbms-aad.database.windows.net/.default',
  );
  return t.token;
}

const password = await token();
const connect = (database) =>
  new pg.Client({ host: HOST, port: 5432, database, user: USER, password,
                  ssl: { rejectUnauthorized: true } });

const admin = connect('postgres');
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
await admin.query(`CREATE DATABASE ${SCRATCH}`);
await admin.end();

const db = connect(SCRATCH);
await db.connect();

try {
  await db.query(readFileSync(new URL('../db/schema.pg.sql', import.meta.url), 'utf8'));
  ok('schema applies', true);

  // A published rate profile, which quotes pin to.
  const prod = await db.query("INSERT INTO product (tag) VALUES ('sse') RETURNING product_id");
  const rp = await db.query(
    'INSERT INTO rate_profile (product_id, version, is_active) VALUES ($1, 1, true) RETURNING rate_profile_id',
    [prod.rows[0].product_id],
  );
  const rateProfileId = rp.rows[0].rate_profile_id;

  // The partial unique index must stop a second ACTIVE profile for one product.
  let blocked = false;
  try {
    await db.query(
      'INSERT INTO rate_profile (product_id, version, is_active) VALUES ($1, 2, true)',
      [prod.rows[0].product_id],
    );
  } catch { blocked = true; }
  ok('a second active rate profile is rejected', blocked);

  // Inactive ones are fine — that is how a new version is staged.
  await db.query(
    'INSERT INTO rate_profile (product_id, version, is_active) VALUES ($1, 2, false)',
    [prod.rows[0].product_id],
  );
  ok('an inactive second profile is allowed', true);

  const active = await db.query(
    "SELECT rate_profile_id FROM active_rate_profile WHERE product_tag = 'sse'",
  );
  ok('active_rate_profile returns exactly one row', active.rowCount === 1);

  // ── customers.js ─────────────────────────────────────────────────────────
  const cust = await db.query(
    `INSERT INTO customer (name, contact_name, phone, email, billing_address, owner_oid)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    ['Acme Industrial', 'Dana Reed', '555-0100', 'dana@acme.test', '1 Mill Rd', 'oid-estimator-1'],
  );
  const customerId = cust.rows[0].customer_id;
  ok('customer insert', cust.rowCount === 1);

  await db.query(
    `INSERT INTO site (customer_id, label, address, city, state, zip, monthly_rate, sort_order)
     VALUES ($1,'Site 1','1 Mill Rd','Fresno','CA','93701',125.00,0)`,
    [customerId],
  );
  const siteRow = await db.query('SELECT site_id FROM site WHERE customer_id = $1', [customerId]);
  ok('site insert', siteRow.rowCount === 1);

  // The site-replace path must not delete a site an agreement still covers.
  const agr = await db.query(
    `INSERT INTO agreement (customer_id, form_data, owner_oid)
     VALUES ($1, '{}'::jsonb, 'oid-estimator-1') RETURNING agreement_id`,
    [customerId],
  );
  await db.query('INSERT INTO agreement_site (agreement_id, site_id) VALUES ($1,$2)',
    [agr.rows[0].agreement_id, siteRow.rows[0].site_id]);
  await db.query(
    `DELETE FROM site WHERE customer_id = $1
       AND site_id NOT IN (SELECT site_id FROM agreement_site)`,
    [customerId],
  );
  const survived = await db.query('SELECT count(*)::int n FROM site WHERE customer_id = $1', [customerId]);
  ok('a site referenced by an agreement survives the replace', survived.rows[0].n === 1);

  // ── quotes.js ────────────────────────────────────────────────────────────
  const q = await db.query(
    `INSERT INTO quote (customer_id, rate_profile_id, estimate_type, system_type, site_type,
                        form_data, recommended_rmr, monitoring_rmr, owner_oid)
     VALUES ($1,$2,'flat_rate','Burg','Commercial',$3,250.00,180.00,'oid-estimator-1')
     RETURNING quote_id, row_version`,
    [customerId, rateProfileId, JSON.stringify({ lines: [{ item: 'Panel', qty: 1 }] })],
  );
  const quoteId = q.rows[0].quote_id;
  ok('quote insert pins a rate profile', q.rows[0].row_version === 1);

  // First save wins.
  const firstSave = await db.query(
    `UPDATE quote SET form_data = $1, updated_at = now(), row_version = row_version + 1
      WHERE quote_id = $2 AND row_version = $3 RETURNING row_version`,
    [JSON.stringify({ lines: [{ item: 'Panel', qty: 2 }] }), quoteId, 1],
  );
  ok('save with the current row_version succeeds', firstSave.rowCount === 1
     && firstSave.rows[0].row_version === 2);

  // Second estimator, still holding version 1, must NOT silently overwrite.
  const staleSave = await db.query(
    `UPDATE quote SET form_data = $1, updated_at = now(), row_version = row_version + 1
      WHERE quote_id = $2 AND row_version = $3 RETURNING row_version`,
    [JSON.stringify({ lines: [{ item: 'Panel', qty: 99 }] }), quoteId, 1],
  );
  ok('a stale save is rejected instead of overwriting', staleSave.rowCount === 0);

  const afterStale = await db.query('SELECT form_data FROM quote WHERE quote_id = $1', [quoteId]);
  ok("the first estimator's work survived", afterStale.rows[0].form_data.lines[0].qty === 2);

  // ── changeRequests.js ────────────────────────────────────────────────────
  const cr = await db.query(
    `INSERT INTO change_request
       (app, page, url, request_type, priority, title, description, desired_result,
        requester_oid, requester_email, requester_name)
     VALUES ('SSE','Quote Builder','https://x/y','bug','high','Totals wrong',
             'The one-time total ignores the markup.', 'Match the recurring panel',
             'oid-estimator-2','dana@acme.test','Dana Reed')
     RETURNING change_request_id, status`,
  );
  const crId = cr.rows[0].change_request_id;
  ok('change request defaults to open', cr.rows[0].status === 'open');

  let badStatus = false;
  try {
    await db.query('UPDATE change_request SET status = $1 WHERE change_request_id = $2',
      ['banana', crId]);
  } catch { badStatus = true; }
  ok('an invalid status is rejected by the constraint', badStatus);

  // The status-change transaction writes the audit note with it.
  await db.query('BEGIN');
  await db.query('UPDATE change_request SET status=$1, updated_at=now() WHERE change_request_id=$2',
    ['in_progress', crId]);
  await db.query(
    `INSERT INTO change_request_note
       (change_request_id, note_type, body, author_oid, author_email, author_name)
     VALUES ($1,'status_change','Status changed from open to in progress.','oid-dev-1','dev@x','Dev')`,
    [crId],
  );
  await db.query('COMMIT');
  const notes = await db.query(
    "SELECT count(*)::int n FROM change_request_note WHERE change_request_id=$1 AND note_type='status_change'",
    [crId],
  );
  ok('a status change leaves an audit note', notes.rows[0].n === 1);

  // The 25 MB attachment ceiling is enforced by the database, not only the upload UI.
  let tooBig = false;
  try {
    await db.query(
      `INSERT INTO change_request_file
         (change_request_id, file_role, storage_path, filename, size_bytes, uploaded_by_oid)
       VALUES ($1,'screenshot','p/x.png','x.png',$2,'oid-1')`,
      [crId, 26214401],
    );
  } catch { tooBig = true; }
  ok('an over-size attachment is rejected', tooBig);

  await db.query(
    `INSERT INTO change_request_file
       (change_request_id, file_role, storage_path, filename, size_bytes, uploaded_by_oid)
     VALUES ($1,'screenshot','p/x.png','x.png',1024,'oid-1')`,
    [crId],
  );
  const list = await db.query('SELECT * FROM change_request_list WHERE change_request_id=$1', [crId]);
  ok('the list view counts notes and files',
     Number(list.rows[0].note_count) === 1 && Number(list.rows[0].file_count) === 1,
     `notes=${list.rows[0].note_count} files=${list.rows[0].file_count}`);

  // Deleting a request must take its notes and files with it.
  await db.query('DELETE FROM change_request WHERE change_request_id=$1', [crId]);
  const orphans = await db.query(
    'SELECT (SELECT count(*)::int FROM change_request_note) n, (SELECT count(*)::int FROM change_request_file) f',
  );
  ok('deleting a request cascades to its notes and files',
     orphans.rows[0].n === 0 && orphans.rows[0].f === 0);
} finally {
  await db.end();
  const a2 = connect('postgres');
  await a2.connect();
  await a2.query(`DROP DATABASE ${SCRATCH}`);
  await a2.end();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
