#!/usr/bin/env node
// Export everything out of the legacy Supabase project, read-only.
//
//   npm run migrate:export
//
// A REHEARSAL, not the cutover. It only ever reads and downloads; nothing here writes
// to Supabase, so it can be run as often as you like and the answer to "did I just
// break production?" is always no.
//
// WHAT IT PULLS
//   cr_requests, cr_files, cr_notes, cr_profiles   the change-request feature
//   app_rates (app='sse')                          THE REAL RATES — one JSON blob
//   auth users                                     the roster, to plan Entra
//   storage bucket 'change-requests'               the attachments themselves
//
// Everything lands in migration-data/<timestamp>/, which is gitignored. That folder
// holds real email addresses and business records; it must never be committed, and it
// is not a backup — it is a working copy you can delete and regenerate.
//
// TWO WAYS IN, and the easy one is the default.
//
//   SUPABASE_SERVICE_KEY   the service_role key. Reaches EVERYTHING — tables through
//                          PostgREST, accounts through the Auth Admin API, files
//                          through the Storage API. Nothing to reset, nothing to
//                          break. Project Settings → API.
//
//   SUPABASE_DB_URL        a direct PostgreSQL connection. Optional. Returns a few
//                          more auth.users columns, and does not paginate.
//
// The database password is NOT your dashboard login — signing in with GitHub never
// sets one, which is why the connection string shows [YOUR-PASSWORD]. You can reset
// it under Project Settings → Database and it is safe to do (the legacy app talks to
// PostgREST with the anon key, not to Postgres) — but the service key makes it
// unnecessary, so prefer that.
//
// CREDENTIALS ARE NEVER ARGUMENTS. They go in .env.migration, gitignored by the
// existing .env.* rule, so they stay out of shell history and out of any transcript.
//
// The service_role key BYPASSES ROW-LEVEL SECURITY. That is exactly why it can export
// everyone's records, and exactly why it must not end up in a commit, a screenshot,
// or the front end.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const EXPECTED_REF = 'xiykhxpuapzaddkbeboz'; // legacy/change-request.js:41
const BUCKET = 'change-requests';            // legacy/change-request.js:43
const APP_TAG = 'sse';                       // legacy/index.html:12545
const API = `https://${EXPECTED_REF}.supabase.co`;

const say = (m) => console.log(`  ${m}`);
const die = (m) => { console.error(`\n  ${m}\n`); process.exit(1); };

// ── Credentials ─────────────────────────────────────────────────────────────
// An already-set environment variable wins over the file, so a one-off override on
// the command line still works.
const ENV_FILE = resolve('.env.migration');
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, '');
    if (value && process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  say('read .env.migration');
}

const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
let DB_URL = process.env.SUPABASE_DB_URL;

// A connection string still carrying the dashboard's placeholder is the single most
// likely mistake here, and Postgres would report it as an authentication failure —
// which reads as "wrong password" rather than "you never set one".
// Catches the dashboard's placeholder AND this repo's own example values. An
// unedited template would otherwise reach Postgres and fail with
// "getaddrinfo ENOTFOUND HOST", which names a DNS problem rather than a file nobody
// filled in.
const UNFILLED = /\[your-password\]|:PASSWORD@|@HOST[:/]|<[^>]+>/i;
if (DB_URL && UNFILLED.test(DB_URL)) {
  say('SUPABASE_DB_URL is still the unedited template — ignoring it');
  say('(signing in with GitHub never sets a database password; the service key is enough)');
  DB_URL = undefined;
}

if (!SERVICE_KEY && !DB_URL) {
  die(
    'No credentials. Create .env.migration in the repo root (it is gitignored):\n\n' +
      '      SUPABASE_SERVICE_KEY=eyJ...\n\n' +
      '  Supabase dashboard → Project Settings → API → service_role key.\n' +
      '  That one value is enough: tables, accounts and files all come through it.\n\n' +
      '  SUPABASE_DB_URL is optional and needs a database password, which signing in\n' +
      '  with GitHub does not give you. You do not need it.',
  );
}

const MODE = DB_URL ? 'postgres' : 'rest';

// ── Output folder ───────────────────────────────────────────────────────────
// Timestamped, so a second run never silently overwrites an export you were halfway
// through comparing against.
const stamp = process.env.EXPORT_STAMP
  || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = resolve('migration-data', stamp);
mkdirSync(join(OUT, 'files'), { recursive: true });

const write = (name, data) => {
  const path = join(OUT, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
};

const report = {
  ref: EXPECTED_REF, mode: MODE, exportedAt: new Date().toISOString(),
  tables: {}, files: {}, warnings: [],
};

const warn = (m) => { report.warnings.push(m); say(`! ${m}`); };

// ── The two ways to read a table ────────────────────────────────────────────
// Same shape either way, so everything below is written once.

const authHeaders = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` });

// PostgREST caps a response, so a table read without paging silently returns the
// first page and looks complete. Paging until a short page arrives is the difference
// between an export and a sample.
const PAGE = 1000;
async function restTable(table) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(`${API}/rest/v1/${table}?select=*&limit=${PAGE}&offset=${offset}`, {
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

let pgClient;
async function pgTable(table) {
  const { rows } = await pgClient.query(`SELECT * FROM ${table}`);
  return rows;
}

async function table(name, pgName = `public.${name}`) {
  try {
    const rows = MODE === 'rest' ? await restTable(name) : await pgTable(pgName);
    write(`${name}.json`, rows);
    report.tables[name] = rows.length;
    say(`${name.padEnd(16)} ${String(rows.length).padStart(5)} row(s)`);
    return rows;
  } catch (err) {
    // A missing table is INFORMATION, not a crash: stopping on the first one would
    // mean exporting nothing at all.
    warn(`${name}: ${err.message}`);
    return null;
  }
}

// ── Accounts ────────────────────────────────────────────────────────────────
// The Auth Admin API is the only way to read accounts without a database password.
// It returns the fields that matter for planning: when they last signed in, whether
// they are banned, what metadata carries their role.
async function restUsers() {
  const users = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`${API}/auth/v1/admin/users?page=${page}&per_page=200`, {
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const batch = body.users || [];
    users.push(...batch);
    if (batch.length < 200) return users;
  }
}

// ── Storage ─────────────────────────────────────────────────────────────────
// list() returns ONE level. The legacy uploader writes to '<requestId>/<filename>',
// so a non-recursive listing finds only folders and reports zero files — which looks
// like an empty bucket rather than a wrong call.
async function restStorageList(prefix = '') {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(`${API}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const page = await res.json();
    for (const entry of page) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      // A folder comes back with a null id and no metadata.
      if (entry.id === null && !entry.metadata) out.push(...await restStorageList(name));
      else out.push({ id: entry.id, name, created_at: entry.created_at, updated_at: entry.updated_at, metadata: entry.metadata });
    }
    if (page.length < PAGE) return out;
  }
}

async function pgStorageList() {
  const { rows } = await pgClient.query(
    `SELECT o.id, o.name, o.created_at, o.updated_at, o.metadata
       FROM storage.objects o JOIN storage.buckets b ON b.id = o.bucket_id
      WHERE b.name = $1 ORDER BY o.name`,
    [BUCKET],
  );
  return rows;
}

async function main() {
  if (MODE === 'postgres') {
    const pg = (await import('pg')).default;
    // Supabase requires TLS but presents a chain this client does not ship a root
    // for. The connection is outbound to a known host to read our own data.
    pgClient = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
    await pgClient.connect();
    say('connected over PostgreSQL');
  } else {
    // Fail here, on one cheap call, rather than after a dozen confusing 401s.
    const probe = await fetch(`${API}/rest/v1/`, { headers: authHeaders() });
    if (probe.status === 401 || probe.status === 403) {
      die(
        `The key in .env.migration was rejected (HTTP ${probe.status}).\n\n` +
          '  It must be the SERVICE_ROLE key, not the anon/publishable one — the anon\n' +
          '  key is subject to row-level security and would export a partial dataset\n' +
          '  that looks complete.\n\n' +
          '  Project Settings → API → service_role.',
      );
    }
    say(`using the service_role key against ${EXPECTED_REF}.supabase.co`);
  }
  console.log('');

  // ── 1. The change-request tables ──────────────────────────────────────────
  const requests = await table('cr_requests');
  await table('cr_files');
  await table('cr_notes');
  await table('cr_profiles');
  // Views, exported to check our rebuilt ones against — derived data, not imported.
  await table('cr_list_view');
  await table('cr_notes_view');

  // ── 2. The rates ──────────────────────────────────────────────────────────
  // The single most important thing in this export. The whole app prices from one
  // JSON blob in one cell, and until it is across, every environment quotes from
  // invented seed numbers.
  const rates = await table('app_rates');
  if (rates) {
    const tags = rates.map((r) => r.app);
    report.appRatesTags = tags;
    say(`  app tags present: ${tags.join(', ')}`);
    // The blast-radius question, answered with data instead of assumption: if other
    // apps keep rates here, this project is not ours alone to delete.
    const others = tags.filter((t) => t !== APP_TAG);
    if (others.length) warn(`app_rates also serves: ${others.join(', ')} — this project is NOT SSE-only`);
    if (!tags.includes(APP_TAG)) warn(`no app_rates row for '${APP_TAG}' — the real rates are not here`);
  }

  // ── 3. The roster ─────────────────────────────────────────────────────────
  // For PLANNING Entra groups — who exists, who is active, who is privileged. Not for
  // migrating credentials, which cannot and must not come across.
  try {
    const users = MODE === 'rest'
      ? await restUsers()
      : (await pgClient.query(
          `SELECT id, email, created_at, last_sign_in_at, email_confirmed_at, banned_until,
                  deleted_at, raw_user_meta_data, raw_app_meta_data, is_super_admin, role
             FROM auth.users ORDER BY created_at`,
        )).rows;
    write('auth_users.json', users);
    report.tables['auth.users'] = users.length;
    say(`${'auth.users'.padEnd(16)} ${String(users.length).padStart(5)} account(s)`);
  } catch (err) {
    warn(`auth users: ${err.message}`);
  }

  // ── 4. Files ──────────────────────────────────────────────────────────────
  let objects = null;
  try {
    objects = MODE === 'rest' ? await restStorageList() : await pgStorageList();
    write('storage_objects.json', objects);
    const bytes = objects.reduce((n, o) => n + Number(o.metadata?.size || 0), 0);
    report.files = { count: objects.length, bytes };
    say(`${'storage'.padEnd(16)} ${String(objects.length).padStart(5)} file(s), ${(bytes / 1048576).toFixed(1)} MB`);
  } catch (err) {
    warn(`storage list: ${err.message}`);
  }

  if (pgClient) await pgClient.end();

  // ── 5. The bytes ──────────────────────────────────────────────────────────
  if (objects?.length && SERVICE_KEY) {
    console.log('');
    say(`downloading ${objects.length} file(s)…`);
    let ok = 0;
    const failed = [];
    for (const o of objects) {
      try {
        const url = `${API}/storage/v1/object/${BUCKET}/${o.name.split('/').map(encodeURIComponent).join('/')}`;
        const res = await fetch(url, { headers: authHeaders() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Flattened onto one level with separators replaced, so a stored path
        // containing '../' cannot write outside the export folder.
        const safe = o.name.replace(/[^a-zA-Z0-9._-]+/g, '_');
        writeFileSync(join(OUT, 'files', safe), Buffer.from(await res.arrayBuffer()));
        ok++;
      } catch (err) {
        failed.push({ name: o.name, error: err.message });
      }
    }
    report.files.downloaded = ok;
    report.files.failed = failed;
    say(`downloaded ${ok}/${objects.length}`);
    if (failed.length) warn(`${failed.length} file(s) failed to download — see report.json`);
  } else if (objects?.length) {
    warn('no service key — file inventory captured, bytes NOT downloaded');
  }

  // A count worth printing on its own: it is the number the import must reproduce.
  if (requests) report.expectRequests = requests.length;

  write('report.json', report);

  console.log('');
  say(`Exported to migration-data/${stamp}/`);
  if (report.warnings.length) {
    console.log('');
    say(`${report.warnings.length} warning(s) — all recorded in report.json`);
  }
  console.log('');
  say('This folder holds real email addresses and business data. It is gitignored;');
  say('keep it that way, and delete it when the rehearsal is done.');
  console.log('');
  say('Next:  npm run migrate:roster');
  console.log('');
}

main().catch(async (err) => {
  if (pgClient) await pgClient.end().catch(() => {});
  die(`Export failed: ${err.message}`);
});
