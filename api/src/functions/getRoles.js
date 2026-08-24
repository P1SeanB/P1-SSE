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
    const groupIds = claims.filter((c) => c.typ === 'groups').map((c) => c.val);

    const roles = [];
    if (groupIds.includes(usersGroupId)) roles.push('sse-users');

    // Optional, and independently fail-closed: unset means nobody is a developer,
    // which leaves statuses unchangeable rather than changeable by anyone.
    const devGroupId = process.env.SSE_DEVELOPERS_GROUP_ID;
    if (devGroupId && groupIds.includes(devGroupId)) roles.push('sse-developers');

    return { jsonBody: { roles } };
  },
});
