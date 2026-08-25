#!/usr/bin/env node
// Load an export into a PostgreSQL database.
//
//   npm run migrate:import                    dry run — reports, writes nothing
//   npm run migrate:import -- --commit        actually write
//   npm run migrate:import -- --commit --i-know-this-is-shared    (Azure targets)
//
// DRY RUN IS THE DEFAULT. Every count and every warning below is produced by doing
// the real work inside a transaction and rolling it back, so the rehearsal exercises
// the same code as the cutover — a dry run that skips the writes proves only that the
// reads work.
//
// IDEMPOTENT. Rows carry their legacy id, so a second run updates instead of
// duplicating. That matters more than it sounds: a migration you cannot re-run is one
// you have to get right first time, on the day, under pressure.
//
// WHAT IT DOES NOT DO
//   - Create Entra accounts or groups. See migration-roster.mjs; membership is a
//     human decision and this repo has no business making it.
//   - Resolve identities. Legacy rows carry Supabase UUIDs and land as
//     'supabase:<uuid>' so they are obvious and greppable until somebody maps them.
//   - Upload attachments to Blob. The bytes are in the export; the rows point at the
//     legacy storage path, and moving them needs the storage account.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import pg from 'pg';

const say = (m) => console.log(`  ${m}`);
const die = (m) => { console.error(`\n  ${m}\n`); process.exit(1); };

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const ACK_SHARED = argv.includes('--i-know-this-is-shared');
const named = argv.find((a) => !a.startsWith('--'));

// ── Find the export ─────────────────────────────────────────────────────────
const ROOT = resolve('migration-data');
if (!existsSync(ROOT)) die('No migration-data/. Run: npm run migrate:export');
const folders = readdirSync(ROOT).filter((f) => existsSync(join(ROOT, f, 'report.json'))).sort();
if (!folders.length) die('No completed export. Run: npm run migrate:export');
const stamp = named || folders[folders.length - 1];
const DIR = join(ROOT, stamp);
if (!existsSync(DIR)) die(`No export "${stamp}". Found: ${folders.join(', ')}`);

const load = (name) => {
  const p = join(DIR, name);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};

// ── Target ──────────────────────────────────────────────────────────────────
// Same settings file the app uses, so the import goes exactly where the app looks and
// there is no second place to configure a database.
const SETTINGS = 'api/local.settings.json';
const values = existsSync(SETTINGS) ? (JSON.parse(readFileSync(SETTINGS, 'utf8')).Values || {}) : {};
const cfg = {
  host: process.env.PGHOST || values.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || values.PGPORT || 5433),
  database: process.env.PGDATABASE || values.PGDATABASE || 'sse',
  user: process.env.PGUSER || values.PGUSER || 'sse',
  password: process.env.PGPASSWORD || values.PGPASSWORD || undefined,
};

const isAzure = /\.postgres\.database\.azure\.com$/i.test(cfg.host);
// Never, under any flag. A rehearsal has no business touching production, and the
// only way to be sure is to make it impossible rather than discouraged.
if (/(^|[-._])prod(uction)?([-._]|$)/i.test(cfg.host)) {
  die(`REFUSING: "${cfg.host}" looks like PRODUCTION. This tool does not write there.`);
}
if (isAzure && COMMIT && !ACK_SHARED) {
  die(
    `"${cfg.host}" is a SHARED Azure server (this app, the estimator and F.R.E.D).\n\n` +
      `  A dry run is fine and needs no flag. To actually write:\n` +
      `      npm run migrate:import -- --commit --i-know-this-is-shared`,
  );
}

async function password() {
  if (cfg.password) return cfg.password;
  const { DefaultAzureCredential } = await import('@azure/identity');
  const token = await new DefaultAzureCredential()
    .getToken('https://ossrdbms-aad.database.windows.net/.default');
  if (!token) throw new Error('No Entra token for PostgreSQL. Run: az login');
  return token.token;
}

// ── Mapping helpers ─────────────────────────────────────────────────────────
// An unmapped identity is written so it CANNOT be mistaken for a real one. A
// plausible-looking id belonging to nobody is the failure mode worth engineering
// against — it survives review, and only surfaces when someone wonders why a request
// has no owner.
const oid = (supabaseId) => (supabaseId ? `supabase:${supabaseId}` : 'supabase:unknown');

const stats = { inserted: {}, updated: {}, skipped: {}, warnings: [] };
const warn = (m) => { stats.warnings.push(m); say(`! ${m}`); };
const bump = (bucket, table) => { stats[bucket][table] = (stats[bucket][table] || 0) + 1; };

async function upsert(client, table, legacyId, columns) {
  const keys = Object.keys(columns);
  const params = keys.map((_, i) => `$${i + 2}`);
  const updates = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const { rows } = await client.query(
    `INSERT INTO ${table} (legacy_id, ${keys.join(', ')})
     VALUES ($1, ${params.join(', ')})
     ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL
     DO UPDATE SET ${updates}
     RETURNING (xmax = 0) AS inserted, ${table.replace(/^.*\./, '')}_id AS id`,
    [legacyId, ...keys.map((k) => columns[k])],
  );
  const row = rows[0];
  bump(row.inserted ? 'inserted' : 'updated', table);
  return row.id;
}

async function main() {
  const client = new pg.Client({
    ...cfg,
    password: await password(),
    ssl: isAzure ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 30_000,
  });
  await client.connect();

  console.log('');
  say(`export : migration-data/${stamp}`);
  say(`target : ${cfg.host}:${cfg.port}/${cfg.database}`);
  say(`mode   : ${COMMIT ? 'COMMIT — this will write' : 'DRY RUN — rolled back at the end'}`);
  console.log('');

  await client.query('BEGIN');
  try {
    // ── Schema ──────────────────────────────────────────────────────────────
    // Applied inside the same transaction as the data. If the load fails, the schema
    // change goes back with it rather than leaving a half-migrated database whose
    // state nobody can describe.
    // The BASELINE ONLY ON AN EMPTY DATABASE. `CREATE TABLE IF NOT EXISTS` is a no-op
    // against tables that already exist, so on an established database the baseline
    // silently skips the tables AND THEN runs its trailing index statements — which
    // reference columns only the migration adds. That fails with
    // 'column "legacy_id" does not exist', which reads as a broken migration rather
    // than as the baseline being the wrong tool for a database that already has a
    // schema.
    //
    // Fresh database  -> baseline, then migrations (which no-op).
    // Existing        -> migrations only. That is what migrations are for.
    const existing = await client.query(
      "SELECT to_regclass('public.change_request') IS NOT NULL AS present",
    );
    if (!existing.rows[0].present) {
      await client.query(readFileSync(resolve('db/schema.pg.sql'), 'utf8'));
      say('empty database — applied the baseline schema');
    } else {
      say('existing schema found — applying migrations only');
    }

    const migrations = readdirSync(resolve('db/migrations'))
      .filter((f) => f.endsWith('.sql')).sort();
    for (const file of migrations) {
      await client.query(readFileSync(resolve('db/migrations', file), 'utf8'));
    }
    say(`applied ${migrations.length} migration(s): ${migrations.join(', ')}`);

    // ── Rates ───────────────────────────────────────────────────────────────
    const appRates = load('app_rates.json') || [];
    const row = appRates.find((r) => r.app === 'sse');
    if (!row) die("No app_rates row for 'sse' in this export.");
    const c = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;

    const product = await client.query(
      `INSERT INTO product (tag) VALUES ('sse')
       ON CONFLICT (tag) DO UPDATE SET tag = EXCLUDED.tag RETURNING product_id`,
    );
    const productId = product.rows[0].product_id;

    // A NEW VERSION, never an edit of the active one. Publishing is how this app
    // records a price change, and rewriting a live profile in place would erase the
    // rates existing quotes were priced from.
    const next = await client.query(
      'SELECT COALESCE(MAX(version), 0) + 1 AS v FROM rate_profile WHERE product_id = $1',
      [productId],
    );
    const version = next.rows[0].v;
    await client.query('UPDATE rate_profile SET is_active = false WHERE product_id = $1', [productId]);
    const profile = await client.query(
      `INSERT INTO rate_profile (product_id, version, is_active, created_by, adc)
       VALUES ($1, $2, true, 'supabase-import', $3) RETURNING rate_profile_id`,
      [productId, version, c.adc ? JSON.stringify(c.adc) : null],
    );
    const rpId = profile.rows[0].rate_profile_id;
    say(`rate_profile v${version} (active)${c.adc ? ' with the Alarm.com sheet' : ' — NO adc key in config'}`);

    const one = async (table, cols) => {
      const keys = Object.keys(cols);
      await client.query(
        `INSERT INTO ${table} (rate_profile_id, ${keys.join(', ')})
         VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')})`,
        [rpId, ...keys.map((k) => cols[k])],
      );
      bump('inserted', table);
    };

    // Every mapping below is config-key -> column. A key missing from the export
    // lands as null rather than silently as zero: null shows up as missing data,
    // zero prices as free.
    const n = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

    await one('labor_rate', {
      labor_cost_per_hr: n(c.laborCostPerHr), labor_bill_default: n(c.laborBillDefault),
      labor_sell_default: n(c.laborSellDefault), svc_gm: n(c.svcGM), sub_markup: n(c.subMarkup),
      av_maint_gm: n(c.avMaintGM), mat_markup: n(c.matMarkup), tm_sub_gm: n(c.tmSubGM),
      overhead_rate: n(c.overheadRate),
    });
    await one('service_call_rate', {
      straight_time_rate: n(c.svcStraight), time_and_half_rate: n(c.svcTimeAndHalf),
      double_time_rate: n(c.svcDoubleTime), priority_multiplier: n(c.priorityMultiplier),
      premier_multiplier: n(c.premierMultiplier),
    });
    await one('monitoring_rate', { base_rate: n(c.monBase), addon_rate: n(c.monAddon) });
    await one('door_rate', { sacp_rate: n(c.doorRateSACP), standard_rate: n(c.doorRateStd) });
    await one('video_rate', { expansion_base_rate: n(c.videoExpansionBase), server_rate: n(c.videoSvr) });
    await one('gcs_rate', {
      fire_rate: n(c.gcsFire), burg_rate: n(c.gcsBurg), residential_rate: n(c.gcsResidential),
      two_way_rate: n(c.gcsTwoWay), sf_burg_residential: n(c.sfBurgResidential),
      sf_burg_commercial: n(c.sfBurgCommercial),
    });
    await one('min_rmr_rate', {
      commercial_floor: n(c.minRMRCommercial), residential_floor: n(c.minRMRResidential),
      two_way_floor: n(c.minRMRTwoWay),
    });

    // misc_rate is key/value, so anything scalar the schema has no column for is kept
    // rather than dropped. Losing a rate silently is worse than storing it untyped.
    // The last three were never in app_rates: the legacy hardcodes them in its markup
    // (legacy/index.html:2037-2039). Carried here so a price change is a rate edit
    // rather than a code change, and so imported profiles are self-describing.
    for (const [key, value] of Object.entries({
      ulCerts: c.ulCerts,
      pmVisitRate: c.pmVisitRate,
      honeywellComm: c.honeywellComm ?? 13.0,
      telguardComm: c.telguardComm ?? 25.0,
      buildingReports: c.buildingReports ?? 6.0,
    })) {
      if (n(value) === null) continue;
      await client.query(
        'INSERT INTO misc_rate (rate_profile_id, rate_key, rate_value) VALUES ($1,$2,$3)',
        [rpId, key, n(value)],
      );
      bump('inserted', 'misc_rate');
    }

    // Three rates per tier — the reason for this migration's tier_rate columns.
    const tierOrder = ['essential', 'priority', 'premier'];
    tierOrder.forEach(() => {});
    for (const [i, name] of tierOrder.entries()) {
      const t = (c.tierRates || {})[name];
      if (!t) { warn(`tierRates.${name} missing from the config`); continue; }
      await one('tier_rate', {
        tier_name: name, label: c.tierRatesLabel || null,
        rate: n(t.st), straight_time: n(t.st), time_and_half: n(t.th), double_time: n(t.dt),
        sort_order: i + 1,
      });
    }

    // Door bundles: the config stores {l: label, v: value} pairs.
    for (const [type, list] of [['SACP', c.doorBundlesSACP], ['Standard', c.doorBundlesStd]]) {
      (list || []).forEach(async () => {});
      let sort = 0;
      for (const b of list || []) {
        sort++;
        // The label carries the range ("9-16 doors"); parsed so the numeric bounds the
        // schema wants are derived from it rather than invented.
        const m = /(\d+)\s*(?:-|–|to)?\s*(\d+)?/.exec(String(b.l || ''));
        await one('door_bundle', {
          bundle_type: type,
          min_doors: m ? Number(m[1]) : sort,
          max_doors: m && m[2] ? Number(m[2]) : null,
          price: n(b.v), sort_order: sort,
        });
      }
    }

    // ── Reference lists ─────────────────────────────────────────────────────
    for (const e of c.estimators || []) {
      const r = await client.query(
        `INSERT INTO estimator (name, email) VALUES ($1, $2)
         ON CONFLICT (lower(email)) WHERE email IS NOT NULL
         DO UPDATE SET name = EXCLUDED.name RETURNING (xmax = 0) AS inserted`,
        [e.name || '(no name)', e.email || null],
      );
      bump(r.rows[0].inserted ? 'inserted' : 'updated', 'estimator');
    }
    for (const v of c.vendors || []) {
      const r = await client.query(
        `INSERT INTO vendor (vendor_key, display, aliases) VALUES ($1, $2, $3)
         ON CONFLICT (lower(vendor_key))
         DO UPDATE SET display = EXCLUDED.display, aliases = EXCLUDED.aliases
         RETURNING (xmax = 0) AS inserted`,
        [String(v.id), v.display || String(v.id), JSON.stringify(v.aliases || [])],
      );
      bump(r.rows[0].inserted ? 'inserted' : 'updated', 'vendor');
    }
    for (const m of c.manufacturers || []) {
      if (!m) continue;
      const r = await client.query(
        `INSERT INTO manufacturer (name) VALUES ($1)
         ON CONFLICT (lower(name)) DO UPDATE SET name = EXCLUDED.name
         RETURNING (xmax = 0) AS inserted`,
        [String(m)],
      );
      bump(r.rows[0].inserted ? 'inserted' : 'updated', 'manufacturer');
    }

    // ── dropdownsHTML -> pricing_option ─────────────────────────────────────
    // The markup is PARSED, not carried across. This app builds its dropdowns from
    // pricing_option, and without this step every dropdown in the UI would be empty
    // and every add-on would price at zero — the rate profile would import cleanly
    // and the app would still be unusable.
    //
    // Turning 16 blocks of <option> markup into rows is the refactor: the same
    // information, queryable, with the price in a numeric column instead of an
    // attribute.
    const entities = (s) => String(s)
      .replace(/&#10;/g, '\n').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
      .replace(/&nbsp;/g, ' ');

    // Attribute order varies in the markup, so each is matched independently rather
    // than with one positional pattern.
    const attr = (tag, name) => {
      const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)
        || new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i').exec(tag);
      return m ? entities(m[1]) : null;
    };

    let optionRows = 0;
    let skippedPlaceholders = 0;
    for (const [group, html] of Object.entries(c.dropdownsHTML || {})) {
      let sort = 0;
      // <optgroup> wrappers are ignored: they group visually, and the app's own
      // components decide presentation now.
      const matches = String(html).matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi);
      for (const [, tag, inner] of matches) {
        const value = attr(tag, 'value');
        if (value === null) continue;
        const label = entities(inner).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        // '— Select … —' placeholders carry value="0" and are UI furniture, not a
        // priced choice. Importing them would put a $0 option in every dropdown that
        // an estimator could pick by accident.
        if (/^—?\s*select\b/i.test(label) || label === '') { skippedPlaceholders++; continue; }
        sort++;
        const price = /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : null;
        await client.query(
          `INSERT INTO pricing_option
             (rate_profile_id, dropdown_group, option_value, label, price, option_type, tooltip, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [rpId, group, value.slice(0, 50), label.slice(0, 200), price,
           attr(tag, 'data-type'), attr(tag, 'title'), sort],
        );
        optionRows++;
      }
    }
    bump('inserted', 'pricing_option');
    stats.inserted.pricing_option = optionRows;
    say(`parsed dropdownsHTML into ${optionRows} pricing_option row(s) across ${Object.keys(c.dropdownsHTML || {}).length} group(s)`);
    if (skippedPlaceholders) say(`  (skipped ${skippedPlaceholders} "select…" placeholder(s))`);
    if (!optionRows) warn('no pricing_option rows parsed — every dropdown in the app would be empty');

    // ── Change requests ─────────────────────────────────────────────────────
    const profiles = load('cr_profiles.json') || [];
    const byId = new Map(profiles.map((p) => [String(p.id), p]));
    const requests = load('cr_requests.json') || [];
    const notes = load('cr_notes.json') || [];
    const files = load('cr_files.json') || [];
    const idMap = new Map();

    for (const r of requests) {
      const who = byId.get(String(r.requester_id)) || {};
      const newId = await upsert(client, 'change_request', r.id, {
        app: r.app || 'SSE', page: r.page || null, url: r.url || null,
        request_type: r.request_type, priority: r.priority || 'normal',
        status: r.status || 'open', title: r.title, description: r.description,
        desired_result: r.desired_result || null,
        requester_oid: oid(r.requester_id),
        requester_email: who.email || null, requester_name: who.display_name || null,
        created_at: r.created_at, updated_at: r.updated_at || r.created_at,
        completed_at: r.completed_at || null,
      });
      idMap.set(r.id, newId);
      if (!byId.has(String(r.requester_id))) {
        warn(`cr_requests #${r.id}: requester ${r.requester_id} has no cr_profiles row`);
      }
    }

    for (const nte of notes) {
      const parent = idMap.get(nte.request_id);
      if (!parent) { bump('skipped', 'change_request_note'); warn(`cr_notes #${nte.id}: request ${nte.request_id} not imported`); continue; }
      const who = byId.get(String(nte.author_id)) || {};
      await upsert(client, 'change_request_note', nte.id, {
        change_request_id: parent, note_type: nte.note_type || 'note', body: nte.body,
        author_oid: oid(nte.author_id), author_email: who.email || null,
        author_name: who.display_name || null, created_at: nte.created_at,
      });
    }

    for (const f of files) {
      const parent = idMap.get(f.request_id);
      if (!parent) { bump('skipped', 'change_request_file'); warn(`cr_files #${f.id}: request ${f.request_id} not imported`); continue; }
      const who = byId.get(String(f.uploaded_by)) || {};
      await upsert(client, 'change_request_file', f.id, {
        change_request_id: parent, file_role: f.file_role,
        // Still the LEGACY path. The bytes are in the export but the Blob container is
        // a separate step; a row pointing at a path nothing serves is honest, whereas
        // an invented Blob path would look migrated and 404 on click.
        storage_path: f.storage_path, filename: f.filename,
        mime_type: f.mime_type || null, size_bytes: f.size_bytes,
        uploaded_by_oid: oid(f.uploaded_by), uploaded_by_name: who.display_name || null,
        uploaded_at: f.uploaded_at,
      });
    }

    // ── Verify before deciding ──────────────────────────────────────────────
    const counts = await client.query(
      `SELECT (SELECT count(*) FROM change_request      WHERE legacy_id IS NOT NULL) AS requests,
              (SELECT count(*) FROM change_request_note WHERE legacy_id IS NOT NULL) AS notes,
              (SELECT count(*) FROM change_request_file WHERE legacy_id IS NOT NULL) AS files,
              (SELECT count(*) FROM estimator)    AS estimators,
              (SELECT count(*) FROM vendor)       AS vendors,
              (SELECT count(*) FROM manufacturer) AS manufacturers,
              (SELECT count(*) FROM tier_rate WHERE rate_profile_id = $1) AS tiers,
              (SELECT adc IS NOT NULL FROM rate_profile WHERE rate_profile_id = $1) AS has_adc`,
      [rpId],
    );
    const got = counts.rows[0];

    console.log('');
    say('loaded:');
    for (const [bucket, label] of [['inserted', 'inserted'], ['updated', 'updated'], ['skipped', 'skipped']]) {
      const entries = Object.entries(stats[bucket]);
      if (entries.length) say(`  ${label}: ${entries.map(([t, n2]) => `${t} ${n2}`).join(', ')}`);
    }
    console.log('');
    say('in the database now:');
    say(`  change_request ${got.requests} (export had ${requests.length})`);
    say(`  notes ${got.notes} (${notes.length}), files ${got.files} (${files.length})`);
    say(`  estimators ${got.estimators}, vendors ${got.vendors}, manufacturers ${got.manufacturers}`);
    say(`  tier_rate ${got.tiers}, Alarm.com sheet present: ${got.has_adc}`);

    // Counts that disagree mean rows were dropped, and a migration that drops rows
    // quietly is worse than one that fails.
    if (Number(got.requests) !== requests.length) warn(`change_request count ${got.requests} != export ${requests.length}`);
    if (Number(got.notes) !== notes.length) warn(`note count ${got.notes} != export ${notes.length}`);
    if (Number(got.files) !== files.length) warn(`file count ${got.files} != export ${files.length}`);

    const unmapped = await client.query(
      "SELECT count(DISTINCT requester_oid) AS n FROM change_request WHERE requester_oid LIKE 'supabase:%'",
    );
    console.log('');
    say(`${unmapped.rows[0].n} distinct identity/identities still unmapped (requester_oid LIKE 'supabase:%')`);
    say('Those must become Entra object ids before cutover — see entra-plan.md.');

    if (COMMIT) {
      await client.query('COMMIT');
      console.log('');
      say('COMMITTED.');
    } else {
      await client.query('ROLLBACK');
      console.log('');
      say('DRY RUN — rolled back, nothing was written.');
      say('Re-run with --commit when the numbers above look right.');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }

  if (stats.warnings.length) {
    console.log('');
    say(`${stats.warnings.length} warning(s) above.`);
  }
  console.log('');
}

main().catch((err) => die(`Import failed: ${err.message}`));
