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
import { existsSync, copyFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WIN = process.platform === 'win32';
const SWA_PORT = 4280;
const API_PORT = 7071;

// ── Who you are locally ─────────────────────────────────────────────────────
// Defaults to signed in with every role, because the alternative — filling in the
// emulator's form by hand on every restart — is friction that teaches nothing.
//
//   npm run dev                      signed in, sse-users + sse-developers
//   npm run dev -- --anon            signed out, to see what an outsider sees
//   npm run dev -- --roles=sse-users only the base role, to check a developer gate
//   npm run dev -- --no-open         start it, do not touch the browser
//
// --anon and --roles matter more than they look. Running as a full developer forever
// means nobody ever exercises the refusal paths, and an authorisation bug that only
// shows up for a colleague is one nobody here can see.
const argv = process.argv.slice(2);
const flag = (name) => argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const flagValue = (name, fallback) => {
  const found = flag(name);
  if (!found) return fallback;
  const [, value] = found.split('=');
  return value ?? fallback;
};
const ANON = Boolean(flag('anon'));
const NO_OPEN = Boolean(flag('no-open'));
const DEV_ROLES = ANON ? '' : flagValue('roles', 'sse-users,sse-developers');
const DEV_USER = flagValue('user', 'localdev');
const PG = { host: 'localhost', port: 5433, database: 'sse', user: 'sse', password: 'sse' };

const say = (m) => console.log(`  ${m}`);
const die = (m) => { console.error(`\n  ${m}\n`); process.exit(1); };

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { stdio: 'inherit', shell: WIN, ...opts });

const quiet = (cmd, args) =>
  spawnSync(cmd, args, { encoding: 'utf8', shell: WIN, stdio: ['ignore', 'pipe', 'pipe'] });

// ── 0. Is Docker even needed? ───────────────────────────────────────────────
// Docker is one way to get a database, not the only one. If api/local.settings.json
// already points somewhere — a shared dev server, a Postgres on another machine —
// the containers are redundant, and demanding Docker anyway would block someone who
// already has everything they need.
const SETTINGS = 'api/local.settings.json';
const pointsAtLocal =
  !existsSync(SETTINGS) ||
  /"PGHOST"\s*:\s*"(localhost|127\.0\.0\.1)"/.test(readFileSync(SETTINGS, 'utf8'));

if (!pointsAtLocal) {
  say(`${SETTINGS} points at a non-local database — skipping the containers`);
  say('(delete it, or set PGHOST to localhost, to go back to Docker)');
  startApp();
} else {

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
startApp();

} // end of the Docker path

// ── Reclaim OUR leftovers, never anyone else's ──────────────────────────────
// A stale process holding 7071 does not announce itself: the new API host dies of
// EADDRINUSE, the SWA CLI keeps running, and the app answers — from the OLD code.
// You then edit a handler, see no change, and start doubting the edit. That already
// cost an afternoon once.
//
// 5173 is why this cannot simply kill whatever it finds: it is Vite's default, so
// the process holding it may be a colleague's other project. The test is whether the
// command line points into THIS repository. Ours gets reclaimed; anything else is
// reported and left alone.
function portOwners(ports) {
  if (WIN) {
    const ps =
      `Get-NetTCPConnection -LocalPort ${ports.join(',')} -State Listen -ErrorAction SilentlyContinue |` +
      ` Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {` +
      ` $p = Get-CimInstance Win32_Process -Filter "ProcessId=$_" -ErrorAction SilentlyContinue;` +
      ` if ($p) { "$($p.ProcessId)|$($p.CommandLine)" } }`;
    // -EncodedCommand, and NOT through a shell. The script contains double quotes and
    // `$(...)`, and passing it as an argument with shell:true hands it to cmd.exe,
    // which eats the quoting and yields an empty result — i.e. "no leftovers found",
    // silently, which is the worst possible failure for this particular check.
    // Base64 UTF-16LE has nothing left for a shell to interpret.
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    const out = spawnSync('powershell', ['-NoProfile', '-EncodedCommand', encoded], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).stdout || '';
    return out.split(/\r?\n/).filter(Boolean).map((line) => {
      const i = line.indexOf('|');
      return { pid: line.slice(0, i).trim(), cmd: line.slice(i + 1).trim() };
    });
  }
  const owners = [];
  for (const port of ports) {
    for (const pid of (quiet('lsof', ['-ti', `tcp:${port}`]).stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)) {
      owners.push({ pid, cmd: (quiet('ps', ['-p', pid, '-o', 'command=']).stdout || '').trim() });
    }
  }
  return owners;
}

function reclaimPorts() {
  let owners;
  try { owners = portOwners([SWA_PORT, API_PORT, 5173]); } catch { return; }
  const here = process.cwd().toLowerCase();
  const isOurs = (cmd) => cmd.toLowerCase().includes(here) || /dev-api[.]mjs/i.test(cmd);
  const mine = owners.filter((o) => isOurs(o.cmd));
  const theirs = owners.filter((o) => !mine.includes(o));

  for (const o of mine) {
    if (WIN) spawnSync('taskkill', ['/PID', o.pid, '/T', '/F'], { stdio: 'ignore' });
    else { try { process.kill(Number(o.pid), 'SIGKILL'); } catch { /* gone */ } }
  }
  if (mine.length) say(`cleared ${mine.length} leftover process(es) from a previous run`);

  if (theirs.length) {
    die(
      `Ports ${[SWA_PORT, API_PORT, 5173].join(', ')} — something NOT from this repo is using one:\n\n` +
        theirs.map((o) => `      pid ${o.pid}  ${o.cmd.slice(0, 90)}`).join('\n') +
        `\n\n  Left alone on purpose: 5173 is Vite's default port and that may well be\n` +
        `  another project of yours. Stop it yourself, or stop that project, and rerun.`,
    );
  }
}

function startApp() {
reclaimPorts();
console.log('');
say(`starting the app — http://localhost:${SWA_PORT}`);
say(ANON ? 'signing you OUT (--anon) — you should see the sign-in wall'
         : `signing you in as "${DEV_USER}" with: ${DEV_ROLES}`);
console.log('');

// The API runs as our own host, not Core Tools — see tools/dev-api.mjs for why.
// --api-devserver-url points the CLI at something already listening instead of
// having it start (and download) a Functions host.
const api = spawn(process.execPath, [resolve('tools/dev-api.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, SSE_DEV_ROLES: DEV_ROLES, SSE_DEV_USER: DEV_USER, SWA_PORT: String(SWA_PORT) },
});
api.on('exit', (code) => {
  if (code) console.error(`\n  The local API host exited with code ${code}.\n`);
});

// Built as a command STRING on Windows rather than args + shell:true. Node deprecates
// that combination (DEP0190) because it concatenates without escaping — and one of
// these arguments contains a space, so it needs quoting either way.
const swaArgs = [
  'start', 'http://localhost:5173',
  '--run', '"npm run dev:vite"',
  '--api-devserver-url', 'http://localhost:7071',
  // A local variant of staticwebapp.config.json WITHOUT rolesSource. In Azure the
  // roles come from GetRoles resolving Entra group claims; the emulator cannot mint
  // those, so rolesSource would fail closed and nobody could ever sign in locally.
  // Without it the roles you type at the login screen apply directly, which is the
  // point of an emulator. Route protection is otherwise identical.
  '--swa-config-location', 'tools/swa-local',
  '--port', String(SWA_PORT),
];
const swa = WIN
  ? spawn(`swa ${swaArgs.join(' ')}`, { stdio: 'inherit', shell: true })
  : spawn('swa', swaArgs.map((a) => a.replace(/^"|"$/g, '')), { stdio: 'inherit', detached: true });

// Declared up here, not next to bye(), because openWhenReady() below reads it and
// would otherwise be relying on the await in its loop to dodge the temporal dead
// zone — true today, and quietly false the moment someone adds an early return.
let leaving = false;

// ── Open the browser, already signed in ─────────────────────────────────────
// Waits for the CLI to actually answer first. Opening immediately lands on a
// connection error, and the instinct then is to reload before it is up rather than
// after — which reads as the app being broken.
if (!NO_OPEN) openWhenReady();

async function openWhenReady() {
  // Served by the API host, not the SWA CLI, because the CLI refuses every route to
  // a caller with no role — including a page whose entire job is to give them one.
  const url = `http://localhost:${API_PORT}/__dev-login`;
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try {
      const res = await fetch(`http://localhost:${SWA_PORT}/.auth/me`, { signal: AbortSignal.timeout(2000) });
      ready = res.ok;
    } catch { /* not listening yet */ }
    if (!ready) await new Promise((r) => setTimeout(r, 1000));
  }
  if (leaving) return;
  if (!ready) {
    say(`the app did not answer on ${SWA_PORT} — open ${url} by hand once it does`);
    return;
  }
  const opener = WIN
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawnSync(opener[0], opener[1], { stdio: 'ignore' });
  console.log('');
  say(`opened your browser — if nothing appeared, go to ${url}`);
  console.log('');
}

// Kill the whole TREE, not the child we happen to hold.
//
// `swa` is three processes deep: this script spawns a shell, the shell spawns the
// SWA CLI, and the CLI spawns `npm run dev:vite`, which spawns Vite. Killing our
// direct child on Windows terminates only that process — every descendant is
// reparented and keeps running, still holding ports 4280 and 5173. The next
// `npm run dev` then fails to bind, or worse, silently attaches to yesterday's
// build and serves stale code while you debug the source.
//
// taskkill /T walks the tree; on POSIX the equivalent is signalling the process
// group, which is what `detached: true` above creates.
const killTree = (child) => {
  if (!child || child.exitCode !== null || !child.pid) return;
  try {
    if (WIN) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGTERM');
  } catch { /* already gone */ }
};

// Containers are deliberately left running: they hold the database you were just
// working in, and stopping them on every Ctrl-C would make local data feel
// disposable when it is not.
const bye = () => {
  if (leaving) return; // Ctrl-C twice shouldn't race two teardowns
  leaving = true;
  killTree(api);
  killTree(swa);
  console.log('\n  Stopped. Containers are still running — `docker compose down` to stop them.\n');
  process.exit(0);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
// If the SWA CLI dies on its own — a port clash, a config it refuses — take the API
// host down with it. Otherwise it survives as an orphan holding 7071, and the next
// run's "address already in use" points at a process nobody remembers starting.
swa.on('exit', (code) => {
  if (leaving) return;
  leaving = true;
  killTree(api);
  process.exit(code ?? 0);
});
}
