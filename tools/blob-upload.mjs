#!/usr/bin/env node
// Move the exported attachments into Azure Blob Storage.
//
//   npm run migrate:blob                    dry run — reports, uploads nothing
//   npm run migrate:blob -- --commit        upload and repoint the rows
//
// Runs after migrate:import. The import writes file rows that still point at the
// LEGACY Supabase path, deliberately: a row pointing at a path nothing serves is
// honest, whereas inventing a Blob path before the bytes exist looks migrated and
// 404s on click. This is the step that makes those paths true.
//
// NO ACCOUNT KEY, EVER. The storage accounts have allowSharedKeyAccess:false, so a
// connection string cannot work even if someone pasted one. Authentication is your
// own Entra identity through DefaultAzureCredential — the same thing `az login`
// gives you, and the same mechanism the Function App uses in Azure via its managed
// identity. That means whoever runs this needs the Storage Blob Data Contributor
// role on the account; owning the subscription is NOT sufficient, because data-plane
// access is a separate grant from management-plane ownership.
//
// IDEMPOTENT. The blob path is derived from the row, never from a clock, so a second
// run computes the same path, sees the same size already there, and skips.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const say = (m) => console.log(`  ${m}`);
const die = (m) => { console.error(`\n  ${m}\n`); process.exit(1); };

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const flagValue = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
};

// ── Export ──────────────────────────────────────────────────────────────────
const ROOT = resolve('migration-data');
if (!existsSync(ROOT)) die('No migration-data/. Run: npm run migrate:export');
const folders = readdirSync(ROOT).filter((f) => existsSync(join(ROOT, f, 'report.json'))).sort();
if (!folders.length) die('No completed export. Run: npm run migrate:export');
const stamp = argv.find((a) => !a.startsWith('--')) || folders[folders.length - 1];
const DIR = join(ROOT, stamp);
if (!existsSync(join(DIR, 'files'))) die(`No files/ in ${stamp} — re-export with SUPABASE_SERVICE_KEY set.`);

// ── Storage ─────────────────────────────────────────────────────────────────
const CONTAINER = process.env.AZURE_STORAGE_CONTAINER || 'change-requests';
const accountArg = flagValue('account');
const ACCOUNT_URL = accountArg
  ? (accountArg.startsWith('http') ? accountArg : `https://${accountArg}.blob.core.windows.net`)
  : process.env.AZURE_STORAGE_ACCOUNT_URL;

if (!ACCOUNT_URL) {
  die(
    'No storage account. Pass one, or set AZURE_STORAGE_ACCOUNT_URL:\n\n' +
      '      npm run migrate:blob -- --account=p1ssestordev\n\n' +
      '  The account must already exist. infra/main.bicep creates it as\n' +
      "  'p1ssestor<env>' with allowSharedKeyAccess:false — deploy that rather than\n" +
      '  making one by hand, so the settings match what the app expects.',
  );
}

// ── Database ────────────────────────────────────────────────────────────────
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
if (/(^|[-._])prod(uction)?([-._]|$)/i.test(cfg.host) || /prod/i.test(ACCOUNT_URL)) {
  die(`REFUSING: "${cfg.host}" / "${ACCOUNT_URL}" looks like PRODUCTION.`);
}

async function password() {
  if (cfg.password) return cfg.password;
  const { DefaultAzureCredential } = await import('@azure/identity');
  const token = await new DefaultAzureCredential()
    .getToken('https://ossrdbms-aad.database.windows.net/.default');
  if (!token) throw new Error('No Entra token for PostgreSQL. Run: az login');
  return token.token;
}

// The export flattened every stored path onto one filename. Recomputed here rather
// than recorded, so the two stay in step by construction.
const flatten = (storagePath) => storagePath.replace(/[^a-zA-Z0-9._-]+/g, '_');

const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

async function main() {
  // Resolved from api/, not from here. @azure/storage-blob is the API's dependency —
  // it belongs to the code that serves attachments, not to the repo root — and ESM
  // does not honour NODE_PATH, so a bare import fails with ERR_MODULE_NOT_FOUND.
  // Installing a second copy at the root to avoid this would risk the migration and
  // the app disagreeing about the SDK version.
  const requireFromApi = createRequire(resolve('api/package.json'));
  const { BlobServiceClient } = await import(pathToFileURL(requireFromApi.resolve('@azure/storage-blob')).href);
  const { DefaultAzureCredential } = await import('@azure/identity');
  const container = new BlobServiceClient(ACCOUNT_URL, new DefaultAzureCredential())
    .getContainerClient(CONTAINER);

  const client = new pg.Client({
    ...cfg, password: await password(),
    ssl: isAzure ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 30_000,
  });
  await client.connect();

  console.log('');
  say(`export   : migration-data/${stamp}`);
  say(`storage  : ${ACCOUNT_URL.replace(/\/+$/, '')}/${CONTAINER}`);
  say(`database : ${cfg.host}/${cfg.database}`);
  say(`mode     : ${COMMIT ? 'COMMIT — uploads and repoints rows' : 'DRY RUN — nothing is uploaded'}`);
  console.log('');

  // Fails here, on one cheap call, rather than after reading every file. The likely
  // cause is a missing DATA-PLANE role, which the management-plane permission that
  // let you see the account in the portal does not imply.
  try {
    await container.getProperties();
  } catch (err) {
    if (err.statusCode === 403) {
      die(
        `Access denied to ${CONTAINER} (HTTP 403).\n\n` +
          '  Owning the subscription is not enough — Blob data access is a separate\n' +
          '  role. Grant yourself Storage Blob Data Contributor on the account:\n\n' +
          '      az role assignment create --role "Storage Blob Data Contributor" \\\n' +
          '        --assignee <your-upn> --scope <storage-account-resource-id>\n\n' +
          '  It can take a minute to take effect.',
      );
    }
    if (err.statusCode === 404) die(`Container "${CONTAINER}" does not exist on that account.`);
    throw err;
  }

  const { rows } = await client.query(
    `SELECT f.change_request_file_id AS id, f.legacy_id, f.change_request_id,
            f.storage_path, f.filename, f.mime_type, f.size_bytes
       FROM change_request_file f
      WHERE f.legacy_id IS NOT NULL
      ORDER BY f.legacy_id`,
  );
  if (!rows.length) die('No imported file rows found. Run: npm run migrate:import -- --commit');

  let uploaded = 0, skipped = 0, repointed = 0, wouldUpload = 0;
  const problems = [];

  // THE EXPORT IS THE AUTHORITY ON WHERE A FILE CAME FROM, not the database row.
  //
  // The row's storage_path is rewritten by this very tool, so using it to locate the
  // local file works exactly once. On a second run the path already points at the
  // Blob location, the lookup misses, and every file is reported as "not in the
  // export" — which reads as data loss when in fact the move succeeded. The legacy
  // path never changes, so keying off it makes re-runs correct instead of alarming.
  const legacyFiles = JSON.parse(readFileSync(join(DIR, 'cr_files.json'), 'utf8'));
  const legacyPath = new Map(legacyFiles.map((f) => [Number(f.id), f.storage_path]));

  for (const r of rows) {
    const original = legacyPath.get(Number(r.legacy_id));
    if (!original) {
      problems.push(`#${r.legacy_id} ${r.filename}: no matching row in this export's cr_files.json`);
      continue;
    }

    const local = join(DIR, 'files', flatten(original));
    if (!existsSync(local)) {
      problems.push(`#${r.legacy_id} ${r.filename}: not in the export (${flatten(original)})`);
      continue;
    }
    const bytes = readFileSync(local);

    // The row is the authority on size. A local file that disagrees means a truncated
    // download, and uploading it would replace a real attachment with a broken one.
    if (Number(r.size_bytes) !== bytes.length) {
      problems.push(`#${r.legacy_id} ${r.filename}: size ${bytes.length} != recorded ${r.size_bytes} — NOT uploaded`);
      continue;
    }

    // Keep the legacy filename portion, swap the request-id prefix to the NEW id.
    // The app's convention is '<change_request_id>/…', and a path claiming a request
    // it does not belong to is the kind of quiet inconsistency that misleads later.
    // Derived from the LEGACY path so it is the same on every run.
    const base = original.split('/').slice(1).join('/') || r.filename;
    const target = `${r.change_request_id}/${base}`;
    const blob = container.getBlockBlobClient(target);

    let exists = false;
    try {
      const props = await blob.getProperties();
      exists = Number(props.contentLength) === bytes.length;
      if (!exists) problems.push(`${target}: already there with a DIFFERENT size (${props.contentLength}) — left alone`);
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }

    say(`${exists ? 'have' : COMMIT ? 'PUT ' : 'would'}  ${target}  (${bytes.length}B, sha ${sha(bytes)})`);

    if (!exists && COMMIT) {
      await blob.uploadData(bytes, {
        blobHTTPHeaders: {
          blobContentType: r.mime_type || 'application/octet-stream',
          // Attachments are downloads, not pages. Without this a stored .html or .svg
          // would render in the browser from the app's own domain if it were ever
          // served directly — the classic stored-XSS route through an upload.
          blobContentDisposition: `attachment; filename="${r.filename.replace(/"/g, '')}"`,
        },
      });
      uploaded++;
      // Read back rather than trusting the call returned. A silent truncation is
      // exactly what a verification step is for.
      const check = await blob.getProperties();
      if (Number(check.contentLength) !== bytes.length) {
        problems.push(`${target}: uploaded ${bytes.length}B but the blob reports ${check.contentLength}B`);
      }
    } else if (exists) {
      skipped++;
    } else {
      wouldUpload++;
    }

    if (COMMIT && r.storage_path !== target) {
      await client.query('UPDATE change_request_file SET storage_path = $1 WHERE change_request_file_id = $2', [target, r.id]);
      repointed++;
    }
  }

  console.log('');
  if (COMMIT) {
    say(`uploaded ${uploaded}, already present ${skipped}, rows repointed ${repointed}`);
    const left = await client.query(
      "SELECT count(*) AS n FROM change_request_file WHERE legacy_id IS NOT NULL AND storage_path !~ ('^' || change_request_id || '/')",
    );
    say(`${left.rows[0].n} row(s) still pointing at a legacy path`);
  } else {
    say(`${wouldUpload} of ${rows.length} file(s) would be uploaded to ${CONTAINER}; ${skipped} already there. Nothing was written.`);
    say('Re-run with --commit when the paths above look right.');
  }

  if (problems.length) {
    console.log('');
    say(`${problems.length} problem(s):`);
    for (const p of problems) say(`  - ${p}`);
  }
  console.log('');
  await client.end();
}

main().catch((err) => die(`Blob upload failed: ${err.message}`));
