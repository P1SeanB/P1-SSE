#!/usr/bin/env node
// A local host for the API, without Azure Functions Core Tools.
//
//   node tools/dev-api.mjs        (npm run dev starts this for you)
//
// WHY THIS EXISTS. Core Tools is the normal way to run Functions locally and this is
// not trying to replace it. On this team's workstations it is unusable twice over:
// it rejects Node 24, and the downloaded func.exe will not execute under the
// endpoint security in place. Neither is fixable from inside the repo, and the
// alternative was that nobody could run the API locally at all.
//
// WHAT IT ACTUALLY RUNS. The real function modules, unmodified. It intercepts the
// app.http() registrations they make on import, then serves those same handlers over
// plain node:http. There is no second copy of any handler — if a route works here it
// is because the deployed code works, not because a stand-in agrees with it.
//
// WHAT IT DOES NOT REPRODUCE. Timers, queue and blob triggers, retry policies,
// scaling, and the exact cold-start behaviour. It is an HTTP host, nothing more.
// Anything relying on those has to be tested in Azure — which is the honest boundary
// of a local emulator anyway, Core Tools included.
import { createServer } from 'node:http';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const PORT = Number(process.env.API_PORT || 7071);
const FUNCTIONS_DIR = resolve('api/src/functions');

// ── Load api/local.settings.json into the environment ───────────────────────
// Core Tools does this, and the handlers read process.env directly, so without it
// every request fails with "PGHOST is not configured" — which is accurate but points
// at the Static Web App's settings rather than at the file actually in play.
//
// An existing environment variable WINS. That keeps a one-off override on the
// command line working, and matches how the real host behaves.
const SETTINGS_PATH = resolve('api/local.settings.json');
if (existsSync(SETTINGS_PATH)) {
  try {
    const { Values } = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    let loaded = 0;
    for (const [k, v] of Object.entries(Values || {})) {
      if (process.env[k] === undefined) { process.env[k] = String(v); loaded++; }
    }
    console.log(`  loaded ${loaded} setting(s) from api/local.settings.json`);
  } catch (err) {
    console.error(`  could not read api/local.settings.json: ${err.message}`);
  }
} else {
  console.error(
    '  api/local.settings.json is missing — copy api/local.settings.json.example',
  );
}

// ── Capture the registrations ───────────────────────────────────────────────
// @azure/functions' app.http() is how each module declares itself. Replacing it
// before the modules load lets them register normally while we keep the routes.
const routes = [];

// Resolved from api/, not from here. This script lives at the repo root but
// @azure/functions is a dependency of the api package, and ESM does not honour
// NODE_PATH — so a bare import fails with ERR_MODULE_NOT_FOUND. The function modules
// themselves resolve correctly, because Node looks up from where THEY sit.
const requireFromApi = createRequire(resolve('api/package.json'));
const { app } = await import(pathToFileURL(requireFromApi.resolve('@azure/functions')).href);
const originalHttp = app.http.bind(app);

app.http = (name, options) => {
  routes.push({
    name,
    methods: (options.methods || ['GET']).map((m) => m.toUpperCase()),
    route: options.route || name,
    handler: options.handler,
  });
  // NOT calling through. Outside the Functions runtime the package switches itself
  // to "test mode" and skips every registration anyway — it says so, once per
  // function, which buries the route list under eighteen warnings about something
  // that was never going to happen. The handler we captured above is the real one
  // either way.
  void originalHttp;
};

for (const file of readdirSync(FUNCTIONS_DIR).filter((f) => f.endsWith('.js'))) {
  await import(pathToFileURL(resolve(FUNCTIONS_DIR, file)).href);
}

// ── Route matching ──────────────────────────────────────────────────────────
// Functions templates look like "change-requests/{id}/files/{fileId}". Compiled
// once, longest-first, so a literal segment always beats a parameter — otherwise
// "change-requests/{id}" would swallow "change-requests/summary".
const compiled = routes.map((r) => {
  const names = [];
  const pattern = r.route
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\{(\w+)\??\}/g, (_, n) => { names.push(n); return '([^/]+)'; });
  return { ...r, names, regex: new RegExp(`^/api/${pattern}/?$`, 'i') };
}).sort((a, b) => (b.route.split('{')[0].length - a.route.split('{')[0].length));

function match(method, pathname) {
  for (const r of compiled) {
    const m = r.regex.exec(pathname);
    if (!m) continue;
    if (!r.methods.includes(method)) continue;
    const params = {};
    r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
    return { route: r, params };
  }
  return null;
}

// ── Adapt node's request to the shape handlers expect ───────────────────────
async function toFunctionsRequest(req, params, body) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  return {
    method: req.method,
    url: url.href,
    params,
    query: url.searchParams,
    headers: {
      get: (name) => req.headers[String(name).toLowerCase()] ?? null,
      has: (name) => Object.prototype.hasOwnProperty.call(req.headers, String(name).toLowerCase()),
    },
    async json() { return body.length ? JSON.parse(body.toString('utf8')) : {}; },
    async text() { return body.toString('utf8'); },
    async arrayBuffer() { return body; },
    // Uploads use this. multipart parsing is not implemented, and pretending
    // otherwise would produce a confusing failure deep in a handler rather than a
    // clear one here.
    async formData() {
      throw new Error(
        'File uploads are not supported by the local API host. Test attachments in Azure.',
      );
    },
  };
}

const context = {
  log: (...a) => console.log('   ', ...a),
  error: (...a) => console.error('   ', ...a),
  warn: (...a) => console.warn('   ', ...a),
  debug: () => {},
};

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;
    const hit = match(req.method, pathname);

    if (!hit) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `No route for ${req.method} ${pathname}` }));
      return;
    }

    const started = Date.now();
    try {
      const request = await toFunctionsRequest(req, hit.params, body);
      const result = (await hit.route.handler(request, context)) || {};

      const status = result.status || 200;
      const headers = { ...(result.headers || {}) };
      let payload;

      if (result.jsonBody !== undefined) {
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
        payload = JSON.stringify(result.jsonBody);
      } else if (result.body !== undefined) {
        payload = result.body;
      } else {
        payload = '';
      }

      res.writeHead(status, headers);
      res.end(payload);
      console.log(`  ${req.method} ${pathname} → ${status} (${Date.now() - started}ms)`);
    } catch (err) {
      // Mirrors what the platform does with an unhandled throw: 500, and the detail
      // goes to the log rather than to the caller.
      console.error(`  ${req.method} ${pathname} → 500: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'The API failed. See the terminal running the local API host.' }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n  Local API host on http://localhost:${PORT}`);
  console.log(`  ${compiled.length} route(s) from api/src/functions:\n`);
  for (const r of compiled) {
    console.log(`    ${r.methods.join(',').padEnd(12)} /api/${r.route}`);
  }
  console.log('');
});
