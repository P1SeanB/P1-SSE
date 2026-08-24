# P1-SSE — RMR Quoting Tool

Migrated from GitHub Pages + Supabase to Azure Static Web Apps + Entra ID SSO + Azure SQL.

## Layout

- `src/` — React + Vite frontend.
  - `tabs/` — the three views: Quote Builder, SLA Creator, Monitoring Contracts.
  - `lib/calc.js` — all pricing math, ported line-for-line from the legacy tool
    (each formula cites its `legacy/index.html` line number).
  - `store/AppState.jsx` — customer + sites state shared across tabs.
- `api/` — Azure Functions (SWA-managed API). `rates` serves the active rate
  profile; `GetRoles` maps Entra security-group membership to the `sse-users`
  SWA role required by every route in `staticwebapp.config.json`.
- `db/schema.sql` — normalized Azure SQL schema (replaces the Supabase
  `app_rates.config` blob). `db/seed.sql.example` documents every rate key and
  dropdown group the frontend expects.
- `infra/main.bicep` — Static Web App (Standard) + Azure SQL (serverless).
- `legacy/index.html` — the original monolith, reference only, not deployed.

## Configuration reference

No rates, credentials, or tenant identifiers are hardcoded in source. All
configuration lives in three places:

### 1. GitHub repo secrets (used by `.github/workflows/azure-static-web-apps.yml`)

| Secret | Purpose |
|---|---|
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | SWA deployment token (from the SWA resource) |
| `AAD_TENANT_ID` | Entra tenant id — substituted into `staticwebapp.config.json` at deploy time (the file cannot reference app settings for `openIdIssuer`) |

### 2. SWA application settings (Azure Portal → Static Web App → Configuration)

| Setting | Used by | Purpose |
|---|---|---|
| `AAD_CLIENT_ID` | SWA auth | Entra app registration client id (referenced by `clientIdSettingName`) |
| `AAD_CLIENT_SECRET` | SWA auth | App registration client secret (referenced by `clientSecretSettingName`) |
| `PGHOST` | `api/src/db.js` | Shared PostgreSQL Flexible Server FQDN. The server is consumed, never managed by this app's template |
| `PGDATABASE` | `api/src/db.js` | This app's database on that server (default `sse`) |
| `PGUSER` | `api/src/db.js` | Entra principal name of the API's managed identity, which is also its PostgreSQL role name |
| `PRODUCT_TAG` | `api/src/functions/rates.js` | Which product's rate profile to serve (defaults to `sse`) |
| `SSE_ENTRA_GROUP_ID` | `api/src/functions/getRoles.js` | Object id of the security group allowed into the app (fails closed if unset) |

### 3. Local dev (`.env.local`, gitignored — see `.env.example`)

| Variable | Purpose |
|---|---|
| `VITE_API_PROXY_TARGET` | Where the Vite dev server proxies `/api` (default `http://localhost:7071`) |

All rate values (labor rates, GCS monitoring, minimum RMR floors, dropdown
menus, fixed monthly services) come from the database at runtime via
`/api/rates` — changing a price never requires a deploy.

## Local dev

```
npm install
npm run dev          # UI only — /.auth/* and /api/* need the SWA CLI emulator
```

For the full auth + API loop use the [SWA CLI](https://learn.microsoft.com/azure/static-web-apps/local-development)
(`swa start`) with `func start` in `api/` (copy `api/local.settings.json.example`
to `api/local.settings.json` first).

## Still open

- Seed the database from the old Supabase `app_rates` row (`db/seed.sql.example`).
- Provision `infra/main.bicep`, create the Entra app registration + security
  group, set the secrets/app settings above.
- Follow-up ports from the legacy tool: customer-quote PDF generation,
  estimate export/import, materials/T&M line-item builder, SLA document
  generator (PM checklist, exclusions, signatures), rich-text notes.
- Legacy parity note: `lib/calc.js` preserves a legacy bug where the minimum
  RMR floor never applies (system-type string mismatch, legacy `:4298`) —
  confirm intended behavior with the business before changing it.
