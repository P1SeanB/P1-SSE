# This branch is the LEGACY app. Build on `development` instead.

`index.html` is a 16,000-line single-file RMR quoting tool. It is **live** — Point 1
estimators quote real jobs from it today, so it is not abandoned and not safe to
break. It is also not where new work goes.

## The replacement already exists

The `development` branch holds a React + Azure rewrite of this app with the same
pricing, split into files, with automated checks that its arithmetic still matches
this one to the cent. It is deployed and being tested.

```bash
git checkout development
```

Read the `CLAUDE.md` at the root of that branch before doing anything. It explains the
layout, the security rules, the parity harness, and how to run it locally
(`npm run dev`, then http://localhost:4280).

## Why this matters more than it looks

**A feature added here has to be ported across by hand.** That is not automatic and it
is not cheap: the Rental Equipment section added in Sept 2026 was 375 lines here and
took a day to bring over safely, because every pricing change has to be re-derived and
proved equivalent before anyone can trust a quote from either tool.

**A feature added on `development` needs no porting at all.** Same work, once.

So unless you are fixing something that is broken for estimators *right now*, the
answer is `development`. If you do have to fix something here, say so clearly in the
commit message, and expect it to be ported.

## If you change this file anyway

- **Never add a credential.** This repository is PUBLIC. `change-request.js` already
  ships a Supabase URL and key in plain source; that is a known problem being retired,
  not a pattern to follow.
- **Never add a password prompt or a roles table.** The replacement gets identity from
  Microsoft Entra. Anything built here that invents its own auth has to be deleted
  rather than ported.
- **Pricing arithmetic is the risk, not the platform.** A wrong number here looks
  exactly like a right one. If you touch a rate or a formula, say which one and why in
  the commit message — the port on `development` is verified line-by-line against this
  file, and a silent change here shows up as a failing check there with no explanation
  attached.

## Branches

| Branch | What it is |
|---|---|
| `main` | this legacy app — live today, retired at cutover |
| `development` | the Azure rewrite — where new work goes |
| `production` | the live Azure site after cutover |
