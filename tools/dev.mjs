#!/usr/bin/env node
// One command to run the app locally.
//
//   npm run dev
//
// Starts the containers, waits for Postgres, seeds the database ONLY if it needs it,
// then hands over to the Static Web Apps CLI. Ctrl-C stops the app; the containers
// keep running, because tearing them down would throw away whatever you were working
// on between runs.
//
// SEEDING IS CONDITIONAL, and that is the important part. Re-seeding on every start
// would republish the rate profile and wipe the quotes you saved yesterday. This
// checks for an active profile and only seeds when there is none — so the first run
// sets you up and every run after leaves your data alone.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, copyFileSync } from 'node:fs';

const WIN = process.platform === 'win32';
const SWA_PORT = 4280;
const PG = { host: 'localhost', port: 5433, database: 'sse', user: 'sse', password: 'sse' };

const say = (m) => console.log(`  ${m}`);
const die = (m) => { console.error(`\n  ${m}\n`); process.exit(1); };

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { stdio: 'inherit', shell: WIN, ...opts });

const quiet = (cmd, args) =>
  spawnSync(cmd, args, { encoding: 'utf8', shell: WIN, stdio: ['ignore', 'pipe', 'pipe'] });

// ── 1. Docker ───────────────────────────────────────────────────────────────
if (quiet('docker', ['--version']).status !== 0) {
  die(
    'Docker is not available on this PATH.\n\n' +
      '  It runs Postgres and Azurite. Install Docker Desktop, or if you have it\n' +
      '  already, start it and run this again.\n\n' +
      '  To use a database elsewhere instead, set PGHOST/PGPORT/PGUSER/PGPASSWORD in\n' +
      '  api/local.settings.json and run: npm run dev:swa',
  );
}

say('starting Postgres and Azurite…');
if (run('docker', ['compose', 'up', '-d']).status !== 0) {
  die('docker compose failed. Is Docker Desktop running?');
}

// ── 2. Wait for Postgres ────────────────────────────────────────────────────
// The container reports "up" long before it accepts connections, and seeding into a
// server that is still starting fails with a connection error that reads like
// misconfiguration.
const { default: pg } = await import('pg');

async function connect(retries = 30) {
  for (let i = 0; i < retries; i++) {
    const client = new pg.Client({ ...PG, ssl: false, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      return client;
    } catch {
      await client.end().catch(() => {});
      if (i === 0) say('waiting for Postgres to accept connections…');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return null;
}

const client = await connect();
if (!client) {
  die(
    'Postgres did not become ready within 30 seconds.\n\n' +
      '  Check it with: docker compose logs postgres',
  );
}

// ── 3. Seed only if there is nothing to use ─────────────────────────────────
let needsSeed = false;
try {
  const active = await client.query(
    `SELECT 1 FROM rate_profile rp
       JOIN product p ON p.product_id = rp.product_id
      WHERE rp.is_active AND p.tag = $1`,
    [process.env.PRODUCT_TAG || 'sse'],
  );
  needsSeed = active.rowCount === 0;
} catch {
  // No tables yet — a first run against an empty volume.
  needsSeed = true;
}
await client.end();

if (needsSeed) {
  say('no active rate profile — applying schema and seeding…');
  const seeded = run(process.execPath, ['tools/seed-local.mjs'], {
    env: { ...process.env, PGHOST: PG.host, PGPORT: String(PG.port), PGDATABASE: PG.database, PGUSER: PG.user, PGPASSWORD: PG.password },
  });
  if (seeded.status !== 0) die('Seeding failed. See the error above.');
} else {
  say('database already seeded — leaving your data alone');
}

// ── 4. Local settings ───────────────────────────────────────────────────────
// The Functions host reads this file, not the environment this script runs in, so a
// missing copy produces a confusing "PGHOST is not configured" from the API rather
// than from here.
if (!existsSync('api/local.settings.json')) {
  copyFileSync('api/local.settings.json.example', 'api/local.settings.json');
  say('created api/local.settings.json from the example');
}

// ── 5. Hand over to the SWA CLI ─────────────────────────────────────────────
console.log('');
say(`starting the app — open http://localhost:${SWA_PORT}`);
say('sign in with any username; give yourself the role "sse-users"');
say('(add "sse-developers" to change a change-request status)');
console.log('');

const swa = spawn(
  'swa',
  ['start', 'http://localhost:5173', '--run', 'npm run dev:vite', '--api-location', 'api', '--port', String(SWA_PORT)],
  { stdio: 'inherit', shell: WIN },
);

// Containers are deliberately left running: they hold the database you were just
// working in, and stopping them on every Ctrl-C would make local data feel
// disposable when it is not.
const bye = () => {
  console.log('\n  Stopped. Containers are still running — `docker compose down` to stop them.\n');
  process.exit(0);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
swa.on('exit', (code) => process.exit(code ?? 0));
