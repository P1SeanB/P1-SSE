# Deploying P1-SSE

Same shape as F.R.E.D and the estimator: a committed `.bicepparam` template per
environment, a gitignored `.local.bicepparam` holding the real values, and secrets
passed on the command line rather than written to either file.

```
infra/main.dev.bicepparam          committed placeholder — do not deploy this
infra/main.dev.local.bicepparam    real values, GITIGNORED — deploy this
infra/main.prod.bicepparam         committed placeholder
infra/main.prod.local.bicepparam   real values, GITIGNORED
```

The extension matters. `az deployment group create -p` picks the parameter format
from the file extension, so the ignored copy is `*.local.bicepparam` — `.local`
**before** `.bicepparam`, never after.

## What this template does not create

The **shared PostgreSQL Flexible Server**. It is live, shared with the estimator and
F.R.E.D, and deliberately outside this template's reach. SSE's own `sse` database on
it already exists; isolation between the three apps is per-database CONNECT, not
separate servers.

## Prerequisites

| Thing | Status | How to check |
|---|---|---|
| App registrations `P1-SSE (dev)` / `P1-SSE (prod)` | exist | `az ad app list --filter "startswith(displayName,'P1-SSE')" -o table` |
| Groups `SSE Users` / `SSE Developers` | exist | `az ad group list --filter "startswith(displayName,'SSE')"` |
| `sse` database on the shared server | exists | `az postgres flexible-server db list -g LegaC-Estimator-Development -s legac-estimator-postgres-dev` |

## Step 1 — fill in the values

```powershell
Copy-Item infra/main.dev.bicepparam infra/main.dev.local.bicepparam
```

Then fill each `FILL →` in the copy. Every value is an identifier — a Postgres FQDN,
a client id, two group object ids — not a credential, which is why they can live in a
file at all.

**`sseUsersGroupObjectId` is effectively required.** `getRoles.js` fails closed when
it is unset, so an environment deployed without it admits *nobody*. A deploy that
succeeds and then refuses every sign-in is almost always this.

## Step 2 — deploy

```powershell
$RG = "LegaC-SSE-Development"
az group create -n $RG -l westus2
az deployment group create -n p1sse-dev -g $RG -f infra/main.bicep `
  -p infra/main.dev.local.bicepparam -p "aadClientSecret=$APP_SECRET"
```

Preview first if the template changed — it prints every resource it would touch, and
a `Modify` or `Delete` where you expected `Create` is worth understanding before you
find out:

```powershell
az deployment group what-if -n p1sse-dev -g $RG -f infra/main.bicep `
  -p infra/main.dev.local.bicepparam
```

Deploying **without** `aadClientSecret` is supported and gets you working
infrastructure with sign-in switched off. Supplying it later and redeploying turns
Easy Auth on. That is the normal path when the secret has not been created yet.

## Step 3 — the redirect URI

The deployment output prints it. Add it to the matching app registration:

```
https://<hostname>/.auth/login/aad/callback
```

Sign-in fails until this exists, with an error naming the redirect URI — which is the
one Entra error that says exactly what is wrong.

## Step 4 — the database role

The Function App authenticates to PostgreSQL as its own managed identity, with a role
scoped to `sse` alone. It must not be able to reach the estimator's or F.R.E.D's
database.

```powershell
node scripts/grant-roles.mjs --app p1sse-api-dev --db sse
```

## Step 5 — blob data access for whoever runs the migration

**Owning the subscription does not grant Blob data access.** It is a separate
data-plane role, and its absence shows up as a 403 that reads like a bug:

```powershell
az role assignment create --role "Storage Blob Data Contributor" `
  --assignee-object-id <your-object-id> --assignee-principal-type User `
  --scope /subscriptions/<sub>/resourceGroups/LegaC-SSE-Development/providers/Microsoft.Storage/storageAccounts/p1ssestordev
```

If that returns `MissingSubscription` — the CLI does this on some versions — go
straight to ARM instead:

```powershell
az rest --method PUT --url "https://management.azure.com/<scope>/providers/Microsoft.Authorization/roleAssignments/<new-guid>?api-version=2022-04-01" --body '{"properties":{"roleDefinitionId":"/subscriptions/<sub>/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe","principalId":"<your-object-id>","principalType":"User"}}'
```

`ba92f5b4-2d11-453d-a403-e96b0029c9fe` is Storage Blob Data Contributor.

## Step 6 — CI

The Static Web App is deployed unlinked on purpose: GitHub Actions deploys it with a
token, which keeps the build definition in this repo rather than in Azure. Put the
deployment token in the repository secrets and push.

```powershell
az staticwebapp secrets list -n p1sse-swa-dev -g $RG --query "properties.apiKey" -o tsv
```

## Migrating the legacy data

Separate from deployment, and documented in the tools themselves. Order matters —
each step depends on the one before:

```bash
npm run migrate:export                                     # from Supabase
npm run migrate:roster                                     # who should exist in Entra
npm run migrate:import                                     # dry run
npm run migrate:import -- --commit --i-know-this-is-shared
npm run migrate:blob -- --account=p1ssestordev             # dry run
npm run migrate:blob -- --account=p1ssestordev --commit
```

Every one of them is dry-run by default and refuses a host that looks like
production.
