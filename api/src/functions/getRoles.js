import { app } from '@azure/functions';

// SWA calls this on every login (staticwebapp.config.json "rolesSource"). It
// receives the AAD claims for the signed-in user and returns the SWA roles to grant.
//
// TWO groups map to two roles:
//   SSE_ENTRA_GROUP_ID      → sse-users       every route requires this
//   SSE_DEVELOPERS_GROUP_ID → sse-developers  may change a change-request's status
//
// Resolving both HERE, once at login, is why no handler has to re-read group claims.
// It also keeps the permission out of the database: the legacy version stored
// is_developer as a column in cr_profiles, a table the requesters themselves could
// write to.
//
// Prerequisites:
//  - the app registration must emit the "groups" claim
//    (App registration → Token configuration → Add groups claim)
//  - a user in more than ~200 groups gets a claims *overage* instead of a list;
//    that is far beyond this tenant, but it is why the check is membership of a
//    known id rather than enumerating what someone belongs to.
app.http('GetRoles', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'GetRoles',
  handler: async (request, context) => {
    const usersGroupId = process.env.SSE_ENTRA_GROUP_ID;
    if (!usersGroupId) {
      // Fail CLOSED. Without the group id configured nobody gets a role, and since
      // every route requires sse-users, nobody gets in. The opposite default — grant
      // when unconfigured — would open the whole app on a missing app setting.
      context.error('SSE_ENTRA_GROUP_ID is not configured — denying all role grants.');
      return { jsonBody: { roles: [] } };
    }

    const payload = await request.json();
    const claims = payload?.claims || [];

    // Microsoft's documented Entra payload uses full schema URIs for claim types and
    // does not include groups at all, which is why their group-based tutorial calls
    // Graph instead. Whether a 'groups' claim actually arrives here depends on the
    // registration's token configuration, so accept both the short name and the URI
    // form rather than assuming one.
    const isGroupClaim = (typ) =>
      typ === 'groups' || typ === 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups';
    const groupIds = claims.filter((c) => isGroupClaim(c.typ)).map((c) => c.val);

    // DIAGNOSTIC, and deliberately not removed after first use: when nobody can sign
    // in, this is the only view into why. The roles function cannot be called
    // externally once rolesSource is configured, so without a log there is nothing to
    // inspect at all.
    //
    // Claim TYPES only, never values — a claims dump would put object ids and email
    // addresses into a log store that is retained and searchable.
    if (!groupIds.length) {
      context.log(
        `[getRoles] no group claim. types received: ${[...new Set(claims.map((c) => c.typ))].join(', ') || '(none)'}`,
      );
    }
    context.log(`[getRoles] ${groupIds.length} group claim(s); expected id present: ${groupIds.includes(usersGroupId)}`);

    const roles = [];
    if (groupIds.includes(usersGroupId)) roles.push('sse-users');

    // Optional, and independently fail-closed: unset means nobody is a developer,
    // which leaves statuses unchangeable rather than changeable by anyone.
    const devGroupId = process.env.SSE_DEVELOPERS_GROUP_ID;
    if (devGroupId && groupIds.includes(devGroupId)) roles.push('sse-developers');

    return { jsonBody: { roles } };
  },
});
