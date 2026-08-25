#!/usr/bin/env node
// Turn the exported Supabase users into an Entra plan.
//
//   npm run migrate:roster              (uses the newest export)
//   npm run migrate:roster -- 2026-08-25T14-02-11
//
// Reads the export only — never Supabase — so it can be re-run and argued with
// without touching the live project.
//
// WHAT THIS IS FOR. Supabase accounts cannot be migrated: the passwords are hashed,
// and Entra would not want them if they were not. What CAN come across is the
// ANSWER TO "who should exist, and what may they do" — which is the part that takes
// human time. This produces that list, with the evidence behind each proposal.
//
// Two privilege levels existed. Everyone with an account could raise and read change
// requests; only cr_profiles.is_developer could change a request's STATUS. That maps
// onto the two groups this app already reads from Entra:
//
//   sse-users        anyone who signs in         SSE_ENTRA_GROUP_ID
//   sse-developers   status changes              SSE_DEVELOPERS_GROUP_ID
//
// NOTHING HERE CHANGES ENTRA. It writes a markdown file for a person to act on.
// Group membership is deliberately not automatable from this repo — see CLAUDE.md.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const say = (m) => console.log(`  ${m}`);
const die = (m) => { console.error(`\n  ${m}\n`); process.exit(1); };

// ── Find the export ─────────────────────────────────────────────────────────
const ROOT = resolve('migration-data');
if (!existsSync(ROOT)) die('No migration-data/ folder. Run: npm run migrate:export');

const named = process.argv.slice(2).find((a) => !a.startsWith('-'));
const folders = readdirSync(ROOT).filter((f) => existsSync(join(ROOT, f, 'report.json'))).sort();
if (!folders.length) die('No completed export found. Run: npm run migrate:export');

const stamp = named || folders[folders.length - 1];
const DIR = join(ROOT, stamp);
if (!existsSync(DIR)) die(`No export named "${stamp}". Found: ${folders.join(', ')}`);
say(`reading migration-data/${stamp}`);

const load = (name) => {
  const path = join(DIR, name);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
};

const users = load('auth_users.json') || [];
const profiles = load('cr_profiles.json') || [];
const requests = load('cr_requests.json') || [];
const notes = load('cr_notes.json') || [];
const files = load('cr_files.json') || [];

if (!users.length) die('auth_users.json is empty or missing — nothing to plan.');

// ── Which column carries the privilege? ─────────────────────────────────────
// Detected rather than assumed. The legacy schema is not in this repo, and guessing a
// column name wrong would silently produce a roster where NOBODY is a developer —
// which looks like a clean answer instead of a broken one.
const profileColumns = profiles.length ? Object.keys(profiles[0]) : [];
const devColumn = profileColumns.find((c) => /is_?developer|is_?admin|is_?dev/i.test(c));
if (profiles.length && !devColumn) {
  say(`! no is_developer-like column in cr_profiles. Columns: ${profileColumns.join(', ')}`);
  say('! everyone will be proposed as sse-users only — check this before acting on it');
}

const profileById = new Map(profiles.map((p) => [String(p.id ?? p.user_id ?? p.uid), p]));

// ── Activity, so "who actually uses this" is evidence and not memory ────────
const activity = new Map();
const bump = (id, key) => {
  if (id == null) return;
  const k = String(id);
  const a = activity.get(k) || { requests: 0, notes: 0, files: 0 };
  a[key]++;
  activity.set(k, a);
};
for (const r of requests) bump(r.requester_id ?? r.requester ?? r.user_id, 'requests');
for (const n of notes) bump(n.author_id ?? n.user_id ?? n.created_by, 'notes');
for (const f of files) bump(f.uploaded_by ?? f.user_id ?? f.created_by, 'files');

// ── Build the roster ────────────────────────────────────────────────────────
const now = Date.now();
const DORMANT_DAYS = 180;

const roster = users.map((u) => {
  const profile = profileById.get(String(u.id)) || {};
  const isDev = devColumn ? Boolean(profile[devColumn]) : false;
  const act = activity.get(String(u.id)) || { requests: 0, notes: 0, files: 0 };
  const touched = act.requests + act.notes + act.files;
  const lastSeen = u.last_sign_in_at ? new Date(u.last_sign_in_at) : null;
  const daysIdle = lastSeen ? Math.floor((now - lastSeen.getTime()) / 86400000) : null;

  const deleted = Boolean(u.deleted_at);
  const banned = u.banned_until && new Date(u.banned_until) > new Date();
  const neverSignedIn = !lastSeen;
  const dormant = daysIdle !== null && daysIdle > DORMANT_DAYS;

  // Deliberately conservative. An account that is deleted, banned, never used, or
  // long dormant gets proposed for NOTHING — migrating a login nobody has used in six
  // months just because it exists is how an app ends up with more access than users.
  let groups = ['sse-users'];
  let note = '';
  if (deleted) { groups = []; note = 'deleted in Supabase'; }
  else if (banned) { groups = []; note = 'banned in Supabase'; }
  else if (neverSignedIn) { groups = []; note = 'never signed in'; }
  else if (dormant && touched === 0) { groups = []; note = `no sign-in for ${daysIdle}d and no activity`; }
  else if (isDev) { groups = ['sse-users', 'sse-developers']; note = 'is_developer in cr_profiles'; }
  else if (dormant) { note = `dormant ${daysIdle}d, but has ${touched} record(s)`; }

  return {
    email: u.email || '(no email)',
    supabaseId: u.id,
    isDev,
    superAdmin: Boolean(u.is_super_admin),
    created: u.created_at ? String(u.created_at).slice(0, 10) : '',
    lastSignIn: lastSeen ? String(u.last_sign_in_at).slice(0, 10) : 'never',
    daysIdle,
    activity: act,
    touched,
    groups,
    note,
  };
});

roster.sort((a, b) => (b.groups.length - a.groups.length) || (b.touched - a.touched) || a.email.localeCompare(b.email));

// ── Report ──────────────────────────────────────────────────────────────────
const devs = roster.filter((r) => r.groups.includes('sse-developers'));
const usersOnly = roster.filter((r) => r.groups.includes('sse-users') && !r.groups.includes('sse-developers'));
const none = roster.filter((r) => r.groups.length === 0);
const orphanIds = [...activity.keys()].filter((id) => !users.some((u) => String(u.id) === id));

const row = (r) =>
  `| ${r.email} | ${r.groups.join(', ') || '—'} | ${r.lastSignIn} | ${r.activity.requests}/${r.activity.notes}/${r.activity.files} | ${r.note} |`;

const md = `# Entra plan from the Supabase roster

Generated from \`migration-data/${stamp}\` — ${users.length} Supabase account(s).

**Nothing here has been applied.** This is a proposal for a person to act on; group
membership is managed in Entra, not from this repo.

Passwords do not migrate. Supabase stores hashes, and Entra would not accept them
anyway — everyone signs in with their existing work account instead, which is the
point of the migration. The work is deciding who gets which group.

## Proposal

| Count | Group | Why |
|---|---|---|
| ${devs.length} | \`sse-users\` + \`sse-developers\` | ${devColumn ? `\`${devColumn}\` set in cr_profiles` : 'no privilege column found — see warning'} |
| ${usersOnly.length} | \`sse-users\` | active account, no elevated flag |
| ${none.length} | none | deleted, banned, never signed in, or dormant with no activity |

Activity is shown as **requests/notes/files** — what the account actually created.

### Should be \`sse-developers\` (${devs.length})

These could change a change-request's status. That is the only privileged action the
legacy app had.

| Email | Groups | Last sign-in | Activity | Why |
|---|---|---|---|---|
${devs.map(row).join('\n') || '| — | | | | none found |'}

### Should be \`sse-users\` (${usersOnly.length})

| Email | Groups | Last sign-in | Activity | Why |
|---|---|---|---|---|
${usersOnly.map(row).join('\n') || '| — | | | | none |'}

### Propose nothing (${none.length})

Not a recommendation to delete anyone — a recommendation not to grant access nobody
has used. Anyone here who turns out to be active just needs adding to \`sse-users\`.

| Email | Groups | Last sign-in | Activity | Why |
|---|---|---|---|---|
${none.map(row).join('\n') || '| — | | | | none |'}

## Before acting on this

1. **Match these to real people.** A Supabase account is an email address; an Entra
   identity is a person in the tenant. Anyone here without a tenant account cannot be
   added to a group — they need an account first, which is a separate decision.
2. **Two groups already exist** and the app reads them: \`SSE_ENTRA_GROUP_ID\` and
   \`SSE_DEVELOPERS_GROUP_ID\`. This does not create groups.
3. **Membership changes need a fresh sign-in.** Roles are baked into the session, so
   somebody added mid-session sees no change and reports it as broken.
${orphanIds.length ? `4. **${orphanIds.length} record(s) reference a user id that no longer exists** in auth.users — deleted accounts whose data outlived them. The import has to decide what to attribute those to.\n` : ''}
## Data these accounts own

| Table | Rows |
|---|---|
| cr_requests | ${requests.length} |
| cr_notes | ${notes.length} |
| cr_files | ${files.length} |
| cr_profiles | ${profiles.length} |
`;

writeFileSync(join(DIR, 'entra-plan.md'), md);
writeFileSync(join(DIR, 'roster.json'), JSON.stringify(roster, null, 2));

console.log('');
say(`${users.length} account(s): ${devs.length} developer, ${usersOnly.length} user, ${none.length} propose nothing`);
if (orphanIds.length) say(`! ${orphanIds.length} user id(s) referenced by data no longer exist in auth.users`);
if (profiles.length && !devColumn) say('! no is_developer column found — the developer list may be wrong');
console.log('');
say(`Wrote migration-data/${stamp}/entra-plan.md`);
console.log('');
