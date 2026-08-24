# P1-SSE — RMR quoting and service agreements (Azure)

Point 1's quoting tool for recurring monthly revenue: build a quote from labor,
monitoring, access-control doors, video and central-station rates; generate SLA
documents; track monitoring contracts and agreements across a customer's sites.
Estimators use it to price work and hand a customer a proposal.

## Architecture

| Layer | Where | Notes |
|---|---|---|
| App | `src/` | React 18 + Vite, built to `dist/` and served by **Azure Static Web Apps** |
| Pricing math | `src/lib/calc.js` | The ONE place rates turn into numbers. Carries citations back to the legacy line numbers it was ported from |
| API | `api/src/functions/` | **Azure Functions v4**, one file per endpoint, linked to the SWA as `/api` |
| Data layer | `api/src/db.js` | The ONLY file that opens a database connection. Everything else calls `query()` / `transaction()` |
| Database | **Azure PostgreSQL Flexible Server** | A database on the SHARED server, alongside the estimator and F.R.E.D. Passwordless — managed identity |
| Files | **Azure Blob Storage** | Change-request attachments. Never made public, never account-key SAS |
| Auth | **Entra ID** via Static Web Apps | `staticwebapp.config.json` + `api/src/functions/getRoles.js` |
| Infra | `infra/` | Bicep — **owned by Solid Networks, do not modify** (see boundary below) |
| Legacy | `legacy/` | Read-only reference copy of the app `main` still ships. Never edited, never shipped |

## Security rules (non-negotiable)

These are written against what this codebase actually did, not generic advice.

1. **Never build a login, password prompt, session, or API key.** `legacy/index.html`
   contains a password sign-in overlay (`#p1-login-overlay`) and
   `legacy/change-request.js` calls Supabase Auth directly. Both are gone here.
   Identity arrives from Entra through Static Web Apps, already verified, in the
   `x-ms-client-principal` header. If a task seems to need a password, stop and ask —
   removing them is the entire point of this migration.

2. **Roles come from Entra groups, never from a table.** The legacy change-request
   feature stored `is_developer` as a column in `cr_profiles` — a flag governing who
   may change a request's status, living in a table the requesters themselves could
   write to. Group membership is resolved in `getRoles.js` from the token's `groups`
   claim. Never add a column that grants permission.

3. **No secrets in this repo, ever.** `legacy/change-request.js` has a Supabase URL
   and publishable key hardcoded in source, which is why that project has to be
   deleted rather than merely disconnected. The only secret in the Azure stack is the
   Entra sign-in client secret, and it lives in Static Web Apps application settings.
   There is no database password — the shared server has password authentication
   disabled entirely.

4. **Every new `/api/*` function needs an auth decision, and it belongs in the
   function.** `staticwebapp.config.json` requires the `sse-users` role on every
   route, so an unauthenticated caller never arrives. That proves the caller is a
   signed-in, permitted user — it does **not** prove they may perform the action.
   Read the principal and check the claim in the handler:

   | Action | Who |
   |---|---|
   | Read rates, list quotes, read a change request | any `sse-users` member |
   | Create or edit a quote, contract, or agreement | any `sse-users` member (they are estimators) |
   | Publish a new rate profile | rate-admin group only — this reprices everything |
   | Change a change-request status | the developers group (`SSE_DEVELOPERS_GROUP_ID`) |

   `authLevel: 'anonymous'` on a function is correct here and does **not** mean
   unauthenticated: it means the platform gate already ran. Don't "fix" it.

5. **`getRoles.js` fails closed and must stay that way.** With
   `SSE_ENTRA_GROUP_ID` unset it returns `{ roles: [] }`, so a misconfigured
   environment admits nobody. The opposite default admits everybody. Never add a
   fallback that grants a role when configuration is missing.

6. **All database access through `api/src/db.js`, always parameterised.** Use
   `query('… WHERE quote_id = $1', [id])`. Never build SQL by string concatenation,
   including for `ORDER BY` — validate against an allowlist instead.

7. **Attachments go to Blob only through the API.** Never make the container public,
   never generate an account-key SAS (the storage account has shared-key access
   disabled, so it would fail anyway). Serve a download by streaming through a
   function, or mint a short-lived **user-delegation** SAS with the managed identity.

8. **No runtime DDL.** The API's database role is DML-only and cannot
   CREATE/ALTER/DROP — deliberately, so an internet-facing app can never alter the
   schema. A `CREATE TABLE` in a handler fails at runtime. See schema changes below.

## Keep it splittable — this is why the rewrite exists

`legacy/index.html` is **16,068 lines in one file**, and `main` grew it by 4,000
lines in six weeks. That is the actual problem this project solves: two people
cannot work on one file without colliding on every change, and no review of a
400-line diff in a 16k-line file is a real review.

So the structure is load-bearing, not decoration:

- **A tab owns a folder.** `src/tabs/QuoteBuilder/`, `src/tabs/SlaCreator/`,
  `src/tabs/MonitoringContracts/`. Work on one tab should touch one folder.
- **Pricing math lives in `src/lib/calc.js`** and nowhere else. A number computed in
  a component is a number nobody can test.
- **One endpoint per file** in `api/src/functions/`.
- **Shared UI goes in `src/components/`**, shared helpers in `src/lib/`.

If a file is heading past a few hundred lines, split it before it lands. Recreating
the monolith in JSX would waste the whole exercise.

## `legacy/` is reference, not source

`legacy/index.html` and `legacy/change-request.js` are a **read-only copy of the app
`main` is still shipping to real estimators today.** They are here so you can port
behaviour accurately and cite where it came from.

- Never edit anything in `legacy/`.
- Never import from it, bundle it, or ship it.
- When porting, leave a comment citing the legacy line numbers, the way
  `src/lib/calc.js` already does. It is what makes a pricing decision auditable
  three months later.

**`main` is still live and still changing.** Unlike a finished migration, the app
this replaces is under active development, so features keep landing there and have to
be brought across. To see what has moved since this copy was taken:

```bash
git diff development..origin/main -- index.html change-request.js
```

## Pricing parity is the risk, not the platform

Rates come out of the database now instead of a JSON blob, but the arithmetic must
match to the cent — an estimator quoting from the new tool has to reach the same
number as the old one. Before trusting any output:

- Both engines are JavaScript. Run the legacy functions and `src/lib/calc.js` over a
  grid of representative inputs (system type × margin × labor hours × platform) and
  diff them. That turns "did the port get the math right" into a test rather than a
  spot check.
- **`src/lib/calc.js:102-111` preserves a real bug on purpose**: the minimum-RMR
  floor never applies, because of a system-type string mismatch. It is kept so the
  new tool matches the old one. Do **not** quietly fix it — it changes quoted prices.
  It needs a decision from the estimating lead, and then either a fix or a comment
  saying it is intended.

## Infrastructure boundary — Solid Networks

Anything below requires Solid Networks. Don't attempt it, and don't work around it in
application code:

- Changes to `infra/`, `.github/workflows/`, `staticwebapp.config.json`'s auth block,
  or anything needing the `az` CLI, the Azure portal, Entra, or new Azure resources.

**Schema changes are yours to make** (NOT a Solid Networks task). Two files must
agree:

1. Add `db/migrations/<timestamp>-what-it-does.sql` — e.g.
   `20260821-1430-add-quote-tags.sql`. Use a **timestamp**, not the next number, so
   two people can't collide. Plain PostgreSQL DDL, idempotent
   (`ADD COLUMN IF NOT EXISTS`).
2. Update `db/schema.pg.sql`, the fresh-deploy baseline.

The pipeline applies migrations on merge. You do **not** need Azure access.

**Who is in the `sse-users` and developers groups is not a code change** — it is
Entra group membership, managed by whoever owns those groups. Adding a person is not
a deploy. They must sign out and back in, because the role is baked into the session
at sign-in; a membership change that "didn't work" is almost always a stale session.

**Anti-workaround rule:** if you're blocked by missing Azure access, stop and say so.
Do NOT hardcode a connection string, re-add Supabase, add a password gate, disable a
route's `allowedRoles`, or store data somewhere else as a substitute. Those are
security incidents, not solutions.

## Development workflow

- **Branch model:** work on a short-lived branch off `development`, PR into it.
  `development` is the Azure app. `production` deploys the live Azure site once
  cutover happens — only merge into it when explicitly asked.
- **`main` is the legacy single-file app that estimators use TODAY.** Don't develop
  there, and don't treat it as abandoned either: it is production until cutover, and
  its changes need porting across.
- **Nothing in Azure is live yet.** Until cutover, estimators quote from the legacy
  page and save `.p1est` files to OneDrive. That means there is no production data to
  lose here yet — and it is also why the database engine and schema could still be
  changed cheaply. That window closes at cutover.

## Testing — run it, don't deploy to find out

```bash
npm install && npm run dev      # Vite dev server
cd api && npm install && npm start   # Functions host on :7071
```

The dev server proxies `/api` to the Functions host. Auth is not enforced locally, so
check role-gated behaviour explicitly rather than assuming the gate works.

**A deploy is for sharing a change, never for finding out whether it works.**
