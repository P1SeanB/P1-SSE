#!/usr/bin/env node
// Export everything out of the legacy Supabase project, read-only.
//
//   npm run migrate:export
//
// A REHEARSAL, not the cutover. It only ever SELECTs and downloads; nothing here
// writes to Supabase, so it can be run as often as you like and the answer to "did I
// just break production?" is always no.
//
// WHAT IT PULLS
//   cr_requests, cr_files, cr_notes, cr_profiles   the change-request feature
//   app_rates (app='sse')                          THE REAL RATES — one JSON blob
//   auth.users                                     the roster, to plan Entra
//   storage bucket 'change-requests'               the attachments themselves
//
// Everything lands in migration-data/<timestamp>/, which is gitignored. That folder
// holds real customer-adjacent data and email addresses; it must never be committed,
// and it is not a backup — it is a working copy you can delete and regenerate.
//
// CREDENTIALS ARE NEVER ARGUMENTS. Put them in .env.migration (gitignored by the
// existing .env.* rule) so they stay out of your shell history and out of any
// transcript:
//
//   SUPABASE_DB_URL=postgresql://postgres:...@aws-0-....pooler.supabase.com:5432/postgres
//   SUPABASE_SERVICE_KEY=eyJ...            (only needed to download file BYTES)
//
// Both come from the Supabase dashboard: Project Settings → Database (the URI), and
// Project Settings → API (the service_role key). The DB URL alone gets you every
// table plus the user roster plus a full inventory of the files; the service key only
// adds downloading their contents.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import pg from 'pg';

const EXPECTED_REF = 'xiykhxpuapzaddkbeboz'; // legacy/change-request.js:41
const BUCKET = 'change-requests';            // legacy/change-request.js:43
const APP_TAG = 'sse';                       // legacy/index.html:12545

const say = (m) => console.log(`  ${m}`);
const die = (m) => { console.error(`\n  ${m}\n`); process.exit(1); };

// ── Credentials ─────────────────────────────────────────────────────────────
// Read from .env.migration if present, but an already-set environment variable wins,
// so CI or a one-off override still works.
const ENV_FILE = resolve('.env.migration');
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  say('read .env.migration');
}

const DB_URL = process.env.SUPABASE_DB_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!DB_URL) {
  die(
    'SUPABASE_DB_URL is not set.\n\n' +
      '  Create .env.migration in the repo root (it is gitignored):\n\n' +
      '      SUPABASE_DB_URL=postgresql://postgres:PASSWORD@HOST:5432/postgres\n' +
      '      SUPABASE_SERVICE_KEY=eyJ...        # optional, to download file bytes\n\n' +
      '  Supabase dashboard → Project Settings → Database → Connection string (URI).\n' +
      '  Use the pooler URI if the direct one will not connect; both work here.',
  );
}

// The ref is in the host of every Supabase connection string. Checking it means a URL
// pasted from the wrong project fails HERE, with a clear message, instead of quietly
// exporting a different app's data and looking like a successful run.
const refInUrl = /(?:db\.|project=)([a-z0-9]{20})/.exec(DB_URL)?.[1]
  || /postgres\.([a-z0-9]{20})[:@]/.exec(DB_URL)?.[1];
if (refInUrl && refInUrl !== EXPECTED_REF) {
  die(
    `That connection string points at project "${refInUrl}", not "${EXPECTED_REF}".\n\n` +
      `  ${EXPECTED_REF} is the project this app actually uses (legacy/change-request.js:41).\n` +
      `  Exporting a different one would produce a plausible-looking but wrong dataset.`,
  );
}
if (!refInUrl) {
  say(`could not read a project ref from the URL — cannot confirm it is ${EXPECTED_REF}`);
}

// ── Output folder ───────────────────────────────────────────────────────────
// Timestamped, so a second run never silently overwrites the export you were halfway
// through comparing against. Passed in rather than computed, because a run should be
// reproducible from its own folder name.
const stamp = process.env.EXPORT_STAMP
  || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = resolve('migration-data', stamp);
mkdirSync(join(OUT, 'files'), { recursive: true });

const write = (name, data) => {
  const path = join(OUT, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
};

// ── Connect ─────────────────────────────────────────────────────────────────
// Supabase requires TLS but presents a certificate this client cannot chain to a root
// it ships with. rejectUnauthorized:false is normally something to argue about; here
// the connection is outbound to a known host, carries no credentials beyond the one
// in the URL, and the alternative is bundling Supabase's CA to read our own data.
const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

const report = { ref: EXPECTED_REF, exportedAt: new Date().toISOString(), tables: {}, files: {}, warnings: [] };

async function tryQuery(label, sql, params = []) {
  try {
    const { rows } = await client.query(sql, params);
    return rows;
  } catch (err) {
    // A missing table is INFORMATION, not a crash: the legacy code references views
    // that may have been dropped, and stopping on the first one would mean exporting
    // nothing. Recorded so the summary tells you what was not found.
    report.warnings.push(`${label}: ${err.message}`);
    say(`! ${label}: ${err.message}`);
    return null;
  }
}

async function main() {
  await client.connect();
  say(`connected to ${new URL(DB_URL.replace(/^postgres(ql)?:/, 'http:')).hostname}`);
  console.log('');

  // ── 1. The change-request tables ──────────────────────────────────────────
  for (const table of ['cr_requests', 'cr_files', 'cr_notes', 'cr_profiles']) {
    const rows = await tryQuery(table, `SELECT * FROM public.${table}`);
    if (!rows) continue;
    write(`${table}.json`, rows);
    report.tables[table] = rows.length;
    say(`${table.padEnd(14)} ${String(rows.length).padStart(5)} row(s)`);
  }

  // ── 2. The rates ──────────────────────────────────────────────────────────
  // The single most important thing in this export. The whole app prices from one
  // JSON blob in one cell, and until it is across, every local and dev environment is
  // quoting from invented numbers.
  const rates = await tryQuery('app_rates', 'SELECT * FROM public.app_rates');
  if (rates) {
    write('app_rates.json', rates);
    report.tables.app_rates = rates.length;
    const tags = rates.map((r) => r.app);
    report.appRatesTags = tags;
    say(`app_rates      ${String(rates.length).padStart(5)} row(s) — app tags: ${tags.join(', ')}`);
    // The blast-radius question, answered with data instead of assumption: if other
    // apps keep their rates in this table, the project is not ours alone to delete.
    const others = tags.filter((t) => t !== APP_TAG);
    if (others.length) {
      report.warnings.push(
        `app_rates also holds rows for: ${others.join(', ')} — this project is NOT SSE-only`,
      );
      say(`  ^ NOTE: other apps use this table too (${others.join(', ')})`);
    }
  }

  // ── 3. The roster ─────────────────────────────────────────────────────────
  // auth.users is readable by the postgres role the connection string uses. This is
  // for PLANNING Entra groups — who exists, who is active, who is privileged — not
  // for migrating credentials, which cannot and must not come across.
  const users = await tryQuery(
    'auth.users',
    `SELECT u.id, u.email, u.created_at, u.last_sign_in_at, u.email_confirmed_at,
            u.banned_until, u.deleted_at, u.raw_user_meta_data, u.raw_app_meta_data,
            u.is_super_admin, u.role
       FROM auth.users u
      ORDER BY u.created_at`,
  );
  if (users) {
    // Passwords are hashed and we never select them, but say so explicitly: the point
    // of this file is who should exist in Entra, not how anyone signed in before.
    write('auth_users.json', users);
    report.tables['auth.users'] = users.length;
    say(`auth.users     ${String(users.length).padStart(5)} row(s)`);
  }

  // ── 4. File inventory ─────────────────────────────────────────────────────
  // storage.objects is a normal table, so the INVENTORY needs no service key. Only
  // the bytes do.
  const objects = await tryQuery(
    'storage.objects',
    `SELECT o.id, o.name, o.created_at, o.updated_at, o.metadata
       FROM storage.objects o
       JOIN storage.buckets b ON b.id = o.bucket_id
      WHERE b.name = $1
      ORDER BY o.created_at`,
    [BUCKET],
  );
  if (objects) {
    write('storage_objects.json', objects);
    const bytes = objects.reduce((n, o) => n + Number(o.metadata?.size || 0), 0);
    report.files.count = objects.length;
    report.files.bytes = bytes;
    say(`storage        ${String(objects.length).padStart(5)} file(s), ${(bytes / 1048576).toFixed(1)} MB`);
  }

  await client.end();

  // ── 5. The bytes ──────────────────────────────────────────────────────────
  if (objects?.length && SERVICE_KEY) {
    console.log('');
    say(`downloading ${objects.length} file(s)…`);
    const base = `https://${EXPECTED_REF}.supabase.co/storage/v1/object/${BUCKET}/`;
    let ok = 0;
    const failed = [];
    for (const o of objects) {
      try {
        const res = await fetch(base + o.name.split('/').map(encodeURIComponent).join('/'), {
          headers: { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        // Flattened onto one level using the storage path with separators replaced,
        // so a path that escapes the folder ('../') cannot write outside it.
        const safe = o.name.replace(/[^a-zA-Z0-9._-]+/g, '_');
        writeFileSync(join(OUT, 'files', safe), buf);
        ok++;
      } catch (err) {
        failed.push({ name: o.name, error: err.message });
      }
    }
    report.files.downloaded = ok;
    report.files.failed = failed;
    say(`downloaded ${ok}/${objects.length}`);
    if (failed.length) say(`! ${failed.length} failed — see report.json`);
  } else if (objects?.length) {
    report.warnings.push('SUPABASE_SERVICE_KEY not set — inventory only, no file bytes');
    console.log('');
    say('SUPABASE_SERVICE_KEY not set: inventory captured, bytes NOT downloaded');
  }

  write('report.json', report);

  console.log('');
  say(`Exported to migration-data/${stamp}/`);
  if (report.warnings.length) {
    console.log('');
    say(`${report.warnings.length} warning(s):`);
    for (const w of report.warnings) say(`  - ${w}`);
  }
  console.log('');
  say('This folder holds real email addresses and business data. It is gitignored;');
  say('keep it that way, and delete it when the rehearsal is done.');
  console.log('');
}

main().catch(async (err) => {
  await client.end().catch(() => {});
  die(`Export failed: ${err.message}`);
});
