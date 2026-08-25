# Running P1-SSE locally

`npm run dev` handles everything. This page explains what it is doing, because when
one of the pieces misbehaves the symptom rarely names the cause.

Three Azure services stand between you and a working local app, and each needs a
different substitute. Notably, running Vite on its own gets you a sign-in wall you
cannot pass — the app asks Static Web Apps who you are, nothing answers, and it stops
there.

| Azure service | Local substitute | Why |
|---|---|---|
| PostgreSQL Flexible Server | Postgres in Docker | Ordinary SQL. Only the *authentication* is Azure-specific — a password here, a managed identity there |
| Blob Storage | **Azurite** | Real emulator, same API |
| Entra sign-in + roles | **SWA CLI** (`/.auth/*`) | Not a container. The CLI serves a fake identity you assign roles to |

## Running it

```bash
npm install && cd api && npm install && cd ..
```

Then, every time:

```bash
npm run dev
```

That starts the containers, waits for Postgres to actually accept connections, seeds
the database **only if it has no active rate profile**, creates
`api/local.settings.json` if it is missing, and starts the app.

Then open **http://localhost:4280** — the SWA CLI's port, not Vite's 5173. Going
straight to 5173 skips the auth emulator and puts you back at the sign-in wall.

Ctrl-C stops the app and **leaves the containers running**, because they hold the
database you were just working in. `docker compose down` when you actually want them
gone.

The conditional seed is the part worth knowing: seeding on every start would
republish the rate profile and throw away quotes you saved yesterday. First run sets
you up; every run after leaves your data alone.

If you would rather drive the pieces yourself — pointing at a database somewhere
else, say — `npm run dev:swa` skips all of the above and just starts the app.

The CLI shows a login screen where you type any username and a list of roles. Enter
the roles the app actually checks:

```
sse-users              can use the app at all
sse-developers         can also change a change-request status
```

Leaving roles blank is worth doing once: it shows what an unauthorised colleague
sees, which is the behaviour `getRoles.js` fails closed to produce.

## Day to day

```bash
npm run dev          # containers, seed if needed, app on :4280
npm run parity       # after ANY change to a pricing engine
npm run coverage     # what is ported and what is not
```

## What the seed gives you

`npm run db:local` applies `db/schema.pg.sql` and publishes one active rate profile.
That step is not optional: the app blocks on the rates call, and with no *active*
profile the API returns 404 and you get an error screen rather than an empty one —
which reads as broken rather than unseeded.

**The seeded numbers are plausible but invented.** They are not Point 1's rates.
Never quote from a local instance, and never point the seed at a real server — it
publishes those invented rates as the active profile, and it refuses any host ending
in `.postgres.database.azure.com` for exactly that reason.

## Configuration

`api/local.settings.json` (gitignored — copy the `.example`):

```json
{
  "IsEncrypted": false,
  "Values": {
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "PGHOST": "localhost",
    "PGPORT": "5433",
    "PGDATABASE": "sse",
    "PGUSER": "sse",
    "PGPASSWORD": "sse",
    "AZURE_STORAGE_CONNECTION_STRING": "UseDevelopmentStorage=true",
    "AZURE_STORAGE_CONTAINER": "change-requests",
    "PRODUCT_TAG": "sse"
  }
}
```

Two of those exist only locally and must never appear in Azure:

- **`PGPASSWORD`** — the shared servers have password authentication disabled
  entirely. In Azure the API authenticates with its managed identity and there is no
  password to set.
- **`AZURE_STORAGE_CONNECTION_STRING`** — Azurite authenticates by shared key, and the
  real storage account has shared-key access disabled. The connection string cannot
  work in Azure, and the managed identity cannot work against Azurite.

Postgres runs on **5433**, not 5432. The estimator and F.R.E.D both run local
Postgres too, and a collision presents as a confusing authentication failure against
whichever container started first.

## Troubleshooting

**Stuck at "Sign-in required."** You are on **5173** instead of **4280**. Vite serves
the app but not `/.auth/*`, so nothing can tell it who you are.

**"No active rate profile for sse."** The seed did not run or did not finish. Force
it with `npm run db:local`.

**"Docker is not available on this PATH."** Docker Desktop is not installed or not
started. If you have a database elsewhere, put its details in
`api/local.settings.json` and use `npm run dev:swa` instead.

**Attachments fail to upload.** Azurite is not running (`docker compose ps`), or
`AZURE_STORAGE_CONNECTION_STRING` is missing from `api/local.settings.json`.

**You want a clean database.** `docker compose down -v` drops the volumes; the next
`npm run dev` re-seeds from scratch. Without `-v` the data survives, which is usually
what you want.

**Roles seem ignored.** The SWA CLI bakes roles into the session at sign-in, exactly
as Entra does. Sign out and back in after changing them — a role change mid-session
does nothing, which is the same behaviour you will see in production.

**A price looks wrong.** Run `npm run parity` before assuming the UI is at fault. It
diffs every pricing engine against the legacy formulas across 17,000+ combinations,
and it has already caught drift that nothing else would have.
