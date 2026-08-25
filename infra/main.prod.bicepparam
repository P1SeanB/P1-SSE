// ═══ PROD placeholder TEMPLATE — committed, contains no real values ══════════
//
// Do not deploy this file. Copy it and fill in the copy, which is gitignored:
//
//   Copy-Item infra/main.prod.bicepparam infra/main.prod.local.bicepparam
//
// Then deploy the .local copy (PowerShell):
//   $RG = "LegaC-SSE-Production"
//   az group create -n $RG -l westus2
//   az deployment group create -n p1sse-prod -g $RG -f infra/main.bicep `
//     -p infra/main.prod.local.bicepparam -p "aadClientSecret=$APP_SECRET"
//
// Secrets are NEVER written to either file — aadClientSecret is passed with -p on
// the command line. Same rule as F.R.E.D and the estimator.
//
// PREREQUISITES (shared, and NOT created by this template):
//   The shared PostgreSQL Flexible Server, with an `sse` database on it. That server
//   is live and shared with the estimator and F.R.E.D; this template consumes it and
//   deliberately cannot touch it. Create the database once by hand — see DEPLOY.md.
//
// Full walkthrough: DEPLOY.md
using './main.bicep'

// DIFFERS per environment: 'prod' here, 'dev' in the dev file.
param environmentName = 'prod'

// ── Shared PostgreSQL (consumed, never managed here) ────────────────────────
// DIFFERS per environment — dev and prod are separate servers.
//   az postgres flexible-server show -g LegaC-Estimator-Production `
//     -n legac-estimator-postgres-prod --query fullyQualifiedDomainName -o tsv
param postgresFqdn = ''  // FILL → .local

// SAME in both environments: SSE's own database on the shared server. Isolation is
// per-database CONNECT, so this name is what keeps SSE out of the estimator's data.
param postgresDatabase = 'sse'

// ── Sign-in app registration ────────────────────────────────────────────────
// DIFFERS per environment: dev and prod each get their OWN registration, so a dev
// sign-in can never mint a token accepted by prod.
// The redirect URI is added right after the first deploy, once the hostname exists
// (DEPLOY.md Step 4) — the deploy output prints the exact URL.
param aadClientId = ''  // FILL → .local (DEPLOY.md Step 2)

// ── Who is allowed in ───────────────────────────────────────────────────────
// DIFFERS per environment — dev and prod groups are separate, so adding someone for
// testing cannot also let them into the live tool.
//
// REQUIRED IN PRACTICE. getRoles.js fails CLOSED when sseUsersGroupObjectId is
// unset: an environment deployed without it admits NOBODY. That is the deliberate
// choice — the opposite default admits everybody — but it does mean a deploy that
// "works" and then refuses every sign-in is almost always this being empty.
//   az ad group show -g "SSE Users" --query id -o tsv
param sseUsersGroupObjectId = ''  // FILL → .local

// Members may change a change-request STATUS. This replaces cr_profiles.is_developer,
// a column the requesters themselves could write to — which is why it is a group and
// not a flag in the database.
//   az ad group show -g "SSE Developers" --query id -o tsv
param sseDevelopersGroupObjectId = ''  // FILL → .local

// ── Rates ───────────────────────────────────────────────────────────────────
// SAME in both environments. Which product row in the rate tables this environment
// prices from; 'sse' matches the legacy app tag carried across from app_rates.
param productTag = 'sse'

// ── CI ──────────────────────────────────────────────────────────────────────
// SAME in both environments. Left empty on purpose: an unlinked Static Web App is
// deployed with a token from GitHub Actions, which keeps the build definition in the
// repo instead of in Azure. Setting it makes Azure own the build.
param repositoryUrl = ''
