#!/usr/bin/env node
// ============================================================================
// Creates the Entra-backed PostgreSQL roles for this app and grants them.
//
// Replaces three psql-only scripts. psql isn't installed on a typical Windows
// workstation and the old scripts used psql-specific syntax (\set, :"var"), so
// this does the same work with the Node pg client — the same client the app and
// the migration runner already use.
//
//   # app role: DML on its own database only
//   node scripts/grant-roles.mjs --app "p1sse-api-dev" --db sse
//
//   # migrator role: DDL on that database (deploy pipeline identity)
//   node scripts/grant-roles.mjs --migrator "<deploy-identity-name>" --db sse
//
//   # both at once
//   node scripts/grant-roles.mjs --app "p1sse-api-dev" --migrator "..." --db sse
//
//   --check    report only, change nothing
//
//   --oid <guid> [--type service|user|group]
//              Bind the role to an Entra OBJECT ID instead of resolving it by
//              display name, so the PostgreSQL role name is independent of the
//              Entra one. Required for the CI deploy identity: its registration is
//              named "P1-SSE deploy" (spaces and dots make a poor PGUSER), and the
//              role wants to be `sse-migrator`. Defaults to --type service.
//              Use the service principal's OBJECT id, not its appId:
//                az ad sp show --id <appId> --query id -o tsv
//
//   --fix-isolation
//              Also CLOSE any cross-database CONNECT leak found, in the safe order:
//              grant an explicit CONNECT to every role that currently depends on
//              PUBLIC, THEN revoke PUBLIC. Without that first step a plain revoke
//              locks other apps out of their own database. Opt-in because it alters
//              privileges on databases owned by OTHER apps. Azure-managed databases
//              (postgres, azure_sys, azure_maintenance) are never touched.
//
// Connect as the PostgreSQL Entra ADMIN (env, same names as everywhere else):
//   PGHOST     the shared server FQDN
//   PGUSER     your Entra admin UPN (or the admin group name)
//   PGPASSWORD omit to authenticate with an Entra token automatically
//
// SHARED-SERVER SAFETY: this server hosts several apps' databases. PostgreSQL
// grants PUBLIC the CONNECT privilege on every new database BY DEFAULT, so until
// it is revoked any app's identity can open a connection to any other app's
// database. This script revokes it on the target database and then prints which
// databases the role can actually reach, so the result is verified rather than
// assumed.
// ============================================================================
import pg from 'pg';

const PG_AAD_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const appRole = flag('app');
const migratorRole = flag('migrator');
const dbName = flag('db') || 'sse';
// Bind the role to an Entra OBJECT ID instead of resolving it by display name.
//
// Needed for the CI deploy identity for two reasons. Its app registration is called
// "P1-SSE deploy" — spaces and dots make a miserable PGUSER — and with an OID the
// PostgreSQL role name no longer has to match the Entra display name at all, so it
// can be `sse-migrator` (mirroring estimator's `estimator-migrator`). Name-based
// lookup does work for the app's managed identities, which is why they were created
// without this.
const oid = flag('oid');
const principalType = flag('type') || 'service'; // user | group | service
const checkOnly = argv.includes('--check');
// Opt-in, because it changes privileges on databases belonging to OTHER apps.
// It always grants dependents explicitly before revoking PUBLIC, so no app loses
// access to its own database. Azure-managed databases are never touched.
const fixIsolation = argv.includes('--fix-isolation');
// Opt-in: strip azure_pg_admin (SERVER-WIDE admin) from the migrator, closing the
// cross-app hole that per-database grants cannot. Applied only AFTER the explicit
// grants and ownership transfer, because that membership is what the role is using to
// migrate today — see grantMigrator().
const dropAdminMembership = argv.includes('--drop-admin-membership');

if (!appRole && !migratorRole && !checkOnly) {
  console.error('Nothing to do. Pass --app <name> and/or --migrator <name> (see the header).');
  process.exit(1);
}

// An OID identifies exactly one principal, so it cannot apply to two roles at once.
if (oid && appRole && migratorRole) {
  console.error('--oid configures ONE principal; run --app and --migrator separately.');
  process.exit(1);
}
if (oid && !/^[0-9a-f-]{36}$/i.test(oid)) {
  console.error(`--oid must be a GUID (the service principal's OBJECT id, not its appId).`);
  process.exit(1);
}
if (!['user', 'group', 'service'].includes(principalType)) {
  console.error('--type must be one of: user, group, service');
  process.exit(1);
}

// Quote an SQL identifier. Role names contain dots and dashes (they are Entra
// principal names), so they MUST be quoted or the statements are syntax errors.
const q = (ident) => `"${String(ident).replace(/"/g, '""')}"`;

async function password() {
  if (process.env.PGPASSWORD) return process.env.PGPASSWORD;
  const { DefaultAzureCredential } = await import('@azure/identity');
  const token = await new DefaultAzureCredential().getToken(PG_AAD_SCOPE);
  if (!token) throw new Error('Could not acquire an Entra token for PostgreSQL.');
  return token.token;
}

async function connect(database) {
  const host = process.env.PGHOST;
  if (!host) throw new Error('PGHOST is not set.');
  if (!process.env.PGUSER) throw new Error('PGUSER is not set (your Entra admin UPN).');
  const client = new pg.Client({
    host,
    port: Number(process.env.PGPORT || 5432),
    database,
    user: process.env.PGUSER,
    password: await password(),
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true },
  });
  await client.connect();
  return client;
}

// ── 1. Create the Entra principal roles (cluster-wide, so against `postgres`) ─
// pgaadauth_create_principal lives only in the postgres database, and roles are
// cluster-wide, so this half runs there regardless of the target database.
async function createPrincipals(names) {
  const client = await connect('postgres');
  try {
    for (const name of names) {
      const { rows } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
      if (rows.length) {
        console.log(`  role ${name} already exists`);
        continue;
      }
      if (checkOnly) {
        console.log(`  WOULD create role ${name}${oid ? ` bound to oid ${oid}` : ''}`);
        continue;
      }
      // isAdmin is false in BOTH branches, deliberately. isAdmin=true grants
      // azure_pg_admin, which is SERVER-WIDE admin over every other app's database
      // on this shared server — that is how estimator's CI identity ended up able
      // to TRUNCATE F.R.E.D's tables. DDL comes from explicit grants and object
      // ownership in grantMigrator() instead.
      if (oid) {
        // (role name, object id, principal type, isAdmin, isMfa)
        await client.query('SELECT pgaadauth_create_principal_with_oid($1, $2, $3, false, false)', [
          name,
          oid,
          principalType,
        ]);
        console.log(`  created role ${name} → ${principalType} ${oid}`);
      } else {
        // (principal name, isAdmin, isMfa) — resolved by display name.
        await client.query('SELECT pgaadauth_create_principal($1, false, false)', [name]);
        console.log(`  created role ${name}`);
      }
    }
  } finally {
    await client.end();
  }
}

// ── 2. Grants on the target database ────────────────────────────────────────
async function grantApp(client, role) {
  // Close the default-open door FIRST, then grant only this app.
  const stmts = [
    `REVOKE CONNECT ON DATABASE ${q(dbName)} FROM PUBLIC`,
    `GRANT CONNECT ON DATABASE ${q(dbName)} TO ${q(role)}`,
    `GRANT USAGE ON SCHEMA public TO ${q(role)}`,
    // DML only. Deliberately no CREATE/ALTER/DROP, and no TRUNCATE — the app has
    // no legitimate need to empty a table wholesale.
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${q(role)}`,
    // Identity columns (crew_members.id, project_jobs.id) need sequence usage or
    // every insert fails at runtime on nextval.
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${q(role)}`,
    // Cover objects created later by this admin.
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${q(role)}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${q(role)}`,
    // Belt and braces: the app must not be able to create objects.
    `REVOKE CREATE ON SCHEMA public FROM ${q(role)}`,
  ];
  for (const s of stmts) {
    if (checkOnly) { console.log(`  WOULD: ${s}`); continue; }
    await client.query(s);
  }
  if (!checkOnly) console.log(`  granted DML on ${dbName} to ${role} (and revoked PUBLIC CONNECT)`);
}

async function grantMigrator(client, role) {
  const stmts = [
    `GRANT CONNECT ON DATABASE ${q(dbName)} TO ${q(role)}`,
    `GRANT USAGE, CREATE ON SCHEMA public TO ${q(role)}`,
    `GRANT ALL ON ALL TABLES IN SCHEMA public TO ${q(role)}`,
    `GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${q(role)}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${q(role)}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${q(role)}`,
  ];
  for (const s of stmts) {
    if (checkOnly) { console.log(`  WOULD: ${s}`); continue; }
    await client.query(s);
  }
  if (!checkOnly) console.log(`  granted DDL on ${dbName} to ${role}`);

  // ── Ownership ──────────────────────────────────────────────────────────────
  // ALTER and DROP require OWNERSHIP of the object. GRANT ALL does NOT confer
  // it. The baseline is normally applied by the admin, so the admin owns every
  // table and a non-admin migrator cannot run `ALTER TABLE ... ADD COLUMN` —
  // which is what almost every migration does.
  //
  // This is the wall estimator hit, and it answered it with isAdmin=true, which
  // grants azure_pg_admin — SERVER-WIDE admin, reaching every other app's
  // database on a shared server. Transferring ownership of just this database's
  // objects gives the migrator exactly the DDL it needs and nothing beyond it.
  const { rows: objs } = await client.query(
    `SELECT c.relname, c.relkind
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'S')
        AND pg_get_userbyid(c.relowner) <> $1
      ORDER BY c.relkind DESC, c.relname`,
    [role]
  );
  for (const o of objs) {
    // ALTER TABLE ... OWNER TO also moves sequences the table owns, so a later
    // ALTER SEQUENCE on one of those is simply a no-op.
    const s = `ALTER ${o.relkind === 'r' ? 'TABLE' : 'SEQUENCE'} ${q(o.relname)} OWNER TO ${q(role)}`;
    if (checkOnly) { console.log(`  WOULD: ${s}`); continue; }
    await client.query(s);
  }
  if (!checkOnly && objs.length) {
    console.log(`  reassigned ${objs.length} object(s) to ${role} — ALTER/DROP needs ownership`);
  }

  // Ownership is exclusive: only the owner, or a role that inherits it, may ALTER or
  // DROP these tables. So after the transfer above, verify the admin running this can
  // still do so — otherwise `npm run db:apply` and any manual schema repair are
  // locked out by the step that was meant to enable migrations.
  //
  // Normally it can, for free: PostgreSQL 16 grants a newly created role back to its
  // CREATEROLE creator automatically, so the admin inherits the migrator. Checking
  // beats assuming, and beats issuing a blind GRANT — `GRANT <role> TO azure_pg_admin`
  // is rejected outright on Azure with 42501 check_restricted_role_alter, because
  // azure_pg_admin's membership is protected.
  if (!checkOnly) {
    const { rows } = await client.query(
      `SELECT pg_has_role($1, $2, 'USAGE') AS inherits`,
      [process.env.PGUSER, role],
    );
    if (rows[0]?.inherits) {
      console.log(`  ${process.env.PGUSER} inherits ${role}, so admin ALTER still works`);
    } else {
      console.log(
        `\n  ⚠ ${process.env.PGUSER} does NOT inherit ${role}, so it can no longer\n` +
          `    ALTER or DROP these tables — \`npm run db:apply\` will fail locally.\n` +
          `    Fix, as an admin with ADMIN OPTION on the role:\n` +
          `      GRANT ${q(role)} TO ${q(process.env.PGUSER)};`,
      );
    }
  }

  // ── Drop server-wide admin ─────────────────────────────────────────────────
  // A migrator created with isAdmin=true is a member of azure_pg_admin, which is
  // admin over EVERY database on this server — so one app's CI identity can read,
  // rewrite or TRUNCATE every other app's data. Per-database grants do not constrain
  // it, because role membership bypasses them entirely. That is how estimator's CI
  // identity ended up able to TRUNCATE F.R.E.D's tables.
  //
  // Safe ONLY in this order, which is why it lives here rather than as loose SQL run
  // by hand: the explicit CONNECT, schema USAGE/CREATE, table privileges and OWNERSHIP
  // above must already be in place. That membership is what the role is currently
  // using to do its job, so revoking it first breaks migrations instead of securing
  // them.
  if (dropAdminMembership) {
    const { rows: member } = await client.query(
      `SELECT 1 FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.member
         JOIN pg_roles g ON g.oid = m.roleid
        WHERE r.rolname = $1 AND g.rolname = 'azure_pg_admin'`,
      [role],
    );
    if (!member.length) {
      console.log(`  ${role} is not a member of azure_pg_admin — nothing to drop`);
    } else {
      const stmt = `REVOKE azure_pg_admin FROM ${q(role)}`;
      if (checkOnly) {
        console.log(`  WOULD: ${stmt}`);
      } else {
        await client.query(stmt);
        console.log(
          `  revoked azure_pg_admin from ${role} — it can no longer reach other apps' databases`,
        );
      }
    }
  }
}

// ── 3. Verify isolation across every database on the shared server ───────────
// Azure manages these three. PUBLIC CONNECT is expected on them, this script
// itself connects to `postgres`, and revoking there can break service internals
// (maintenance, Query Store). They appear in the matrix but never count as a leak.
const SYSTEM_DBS = new Set(['postgres', 'azure_sys', 'azure_maintenance']);

// Azure creates these roles and manages their access. They must never be handed a
// new explicit grant by this script: `replication` is not flagged as a superuser
// yet reaches every database via PUBLIC, so without this it would be "preserved"
// and pick up an explicit CONNECT it never needed.
const SYSTEM_ROLES = new Set(['azuresu', 'replication', 'azure_pg_admin', 'azure_superuser']);

// Which login roles can reach `db` today, and do they hold an EXPLICIT CONNECT
// grant or are they relying on PUBLIC's default?
//
// Uses aclexplode rather than matching datacl as text: role names appear QUOTED
// in the text form (`"my-app"=c/owner`), so a naive LIKE '%role=%' reports "no
// explicit grant" for every role and makes a safe revoke look dangerous.
async function connectDependents(client, db, configuredRoles) {
  const { rows } = await client.query(
    `SELECT r.rolname, r.rolsuper,
            -- Would this role STILL reach the database after PUBLIC loses
            -- CONNECT? True when some non-PUBLIC grantee holding CONNECT either
            -- IS this role or is a role it inherits from. That is the exact
            -- question, so ask it directly rather than inferring.
            --
            -- Inheritance is the part that matters: estimator-migrator holds no
            -- CONNECT entry of its own, yet keeps access through azure_pg_admin
            -- membership. Checking only for a direct grant would mark it as
            -- needing preservation and hand it a redundant explicit grant.
            EXISTS (
              SELECT 1 FROM pg_database d2, aclexplode(d2.datacl) a
               WHERE d2.datname = $1
                 AND a.privilege_type = 'CONNECT'
                 AND a.grantee <> 0
                 AND pg_has_role(r.oid, a.grantee, 'USAGE')
            ) AS keeps_access,
            -- Can it already reach OUR database? Then it is one of THIS app's roles
            -- and must not be preserved on a neighbour's.
            has_database_privilege(r.rolname, $2, 'CONNECT') AS is_ours
       FROM pg_roles r
      WHERE r.rolcanlogin
        AND r.rolname NOT LIKE 'pg\\_%'
        AND has_database_privilege(r.rolname, $1, 'CONNECT')
      ORDER BY r.rolname`,
    [db, dbName]
  );
  // Preserve only roles that would genuinely LOSE access. Excluded:
  //   keeps_access  — retains CONNECT by another path, so needs nothing.
  //   rolsuper      — superusers bypass ACL checks entirely.
  //   Azure's roles — service-managed; never hand them new grants.
  //   configuredRoles — the roles THIS run is setting up. Stripping their reach
  //     into a neighbouring app's database is the entire point, so preserving
  //     them would entrench the leak as an explicit grant that survives a revoke.
  //   is_ours — a role that can already reach OUR database belongs to THIS app, so
  //     losing its reach into a neighbour's is the desired outcome, not a regression.
  //     configuredRoles alone is not enough: it only covers the role named in THIS
  //     invocation, and each app has several (app, scheduled job, migrator). Granting
  //     one app's role explicit CONNECT on another app's database would convert a
  //     default that a revoke removes into a grant that survives one — the exact leak
  //     being closed. This is what made --fix-isolation want to run
  //     `GRANT CONNECT ON DATABASE estimator TO legac-fred-app-prod`.
  return rows.filter(
    (r) =>
      !r.keeps_access &&
      !r.is_ours &&
      !r.rolsuper &&
      !SYSTEM_ROLES.has(r.rolname) &&
      !r.rolname.startsWith('azure') &&
      !configuredRoles.includes(r.rolname)
  );
}

async function report(client, allRoles) {
  // has_database_privilege() errors with 42704 on a role that does not exist, so
  // under --check — where nothing was actually created — the matrix would crash
  // instead of reporting. Report on what exists and say what was omitted.
  const { rows: found } = await client.query(
    `SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])`,
    [allRoles],
  );
  const present = new Set(found.map((r) => r.rolname));
  const roles = allRoles.filter((r) => present.has(r));
  const missing = allRoles.filter((r) => !present.has(r));

  if (missing.length) {
    console.log(`\n  Not created yet, so omitted from the matrix: ${missing.join(', ')}`);
  }
  if (!roles.length) {
    console.log('  Nothing to report on until at least one role exists.');
    return;
  }

  const { rows } = await client.query(
    `SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname`
  );
  console.log('\nCONNECT privileges per database (each role should reach ONLY its own):');
  const width = Math.max(...rows.map((r) => r.datname.length), 8);
  console.log(`  ${'database'.padEnd(width)}  ${roles.join('  ')}`);
  const leaks = [];
  for (const { datname } of rows) {
    const cells = [];
    let anyOk = false;
    for (const role of roles) {
      const { rows: p } = await client.query(
        `SELECT has_database_privilege($1, $2, 'CONNECT') AS ok`,
        [role, datname]
      );
      const ok = p[0]?.ok === true;
      if (ok) anyOk = true;
      cells.push((ok ? 'YES' : '-').padEnd(role.length));
    }
    const system = SYSTEM_DBS.has(datname);
    if (anyOk && datname !== dbName && !system) leaks.push(datname);
    console.log(
      `  ${datname.padEnd(width)}  ${cells.join('  ')}` +
        (system ? '   (Azure-managed — not a leak)' : '')
    );
  }

  if (!leaks.length) {
    console.log('\n  Isolation looks correct.');
    return;
  }

  const apply = fixIsolation && !checkOnly;

  // WHY can the role reach that database? Revoking PUBLIC only helps if PUBLIC is
  // how it gets in. Role membership (notably azure_pg_admin) and superuser bypass
  // PUBLIC entirely, so reporting "revoke PUBLIC" there is advice that changes
  // nothing while looking like a fix — which is exactly how a leak survives being
  // "closed". Diagnose before prescribing.
  const viaMembership = [];
  for (const db of leaks) {
    const { rows } = await client.query(
      `SELECT (d.datacl IS NULL) OR EXISTS (
                SELECT 1 FROM aclexplode(d.datacl) a
                 WHERE a.grantee = 0 AND a.privilege_type = 'CONNECT'
              ) AS public_open
         FROM pg_database d WHERE d.datname = $1`,
      [db],
    );
    if (rows[0]?.public_open) continue; // PUBLIC really is the way in

    // PUBLIC is already closed, so find the role(s) that carry the access.
    const { rows: paths } = await client.query(
      `SELECT g.rolname
         FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.member
         JOIN pg_roles g ON g.oid = m.roleid
        WHERE r.rolname = ANY($1::text[])
        ORDER BY g.rolname`,
      [roles],
    );
    viaMembership.push({ db, groups: [...new Set(paths.map((p) => p.rolname))] });
  }

  console.log(
    `\n  ⚠ A role here can CONNECT to: ${leaks.join(', ')}. Those databases still\n` +
      `    carry PUBLIC's default CONNECT.\n` +
      `\n    ORDER MATTERS — revoking PUBLIC first can lock another app out of its OWN\n` +
      `    database. Any role that reaches it only through PUBLIC loses access the\n` +
      `    instant PUBLIC is revoked. Grant those roles explicitly FIRST, then revoke.\n` +
      (apply
        ? `    Applying now (--fix-isolation):\n`
        : `    Re-run with --fix-isolation to apply exactly this, or run it as admin\n` +
          `    yourself (from any database on this server):\n`)
  );

  // Membership-borne access first: it is not fixable by revoking PUBLIC, and saying
  // so prevents a no-op being mistaken for a remediation.
  for (const { db, groups } of viaMembership) {
    console.log(
      `    -- ${db}: PUBLIC is ALREADY revoked here. The access comes from role` +
        ` membership` + (groups.length ? ` (${groups.join(", ")})` : ``) + `, which` +
        ` bypasses PUBLIC entirely.`,
    );
    console.log(
      `    --   Revoking PUBLIC would change nothing. Fix it by removing the` +
        ` membership, AFTER granting the role the explicit rights it still needs on` +
        ` its own database:  REVOKE ${groups.join(", ")} FROM ${roles.map(q).join(", ")};`,
    );
  }
  const publicLeaks = leaks.filter((d) => !viaMembership.some((v) => v.db === d));
  for (const db of publicLeaks) {
    const dependents = await connectDependents(client, db, roles);
    const stmts = [
      ...dependents.map((d) => `GRANT CONNECT ON DATABASE "${db}" TO "${d.rolname}"`),
      `REVOKE CONNECT ON DATABASE "${db}" FROM PUBLIC`,
    ];
    console.log(`    -- ${db}`);
    if (dependents.length) {
      console.log(`    --   relies on PUBLIC today, so must be preserved first:`);
    } else {
      console.log(`    --   nothing relies on PUBLIC here; revoking directly is safe`);
    }
    for (const s of stmts) {
      if (apply) {
        await client.query(s);
        console.log(`    ok: ${s};`);
      } else {
        console.log(`    ${s};`);
      }
    }
    console.log('');
  }
  if (apply) {
    console.log('    Re-run without --fix-isolation to confirm the matrix is clean.');
  }
}

// ── main ────────────────────────────────────────────────────────────────────
const roles = [appRole, migratorRole].filter(Boolean);

console.log(`Server:   ${process.env.PGHOST}`);
console.log(`Database: ${dbName}`);
console.log(`Admin:    ${process.env.PGUSER}`);
if (checkOnly) console.log('Mode:     --check (no changes)\n');
else console.log('');

if (roles.length) {
  console.log('Roles:');
  await createPrincipals(roles);
}

const client = await connect(dbName);
try {
  if (appRole) {
    console.log(`\nApp role ${appRole}:`);
    await grantApp(client, appRole);
  }
  if (migratorRole) {
    console.log(`\nMigrator role ${migratorRole}:`);
    await grantMigrator(client, migratorRole);
  }
  if (roles.length) await report(client, roles);
} finally {
  await client.end();
}
console.log('\nDone.');
