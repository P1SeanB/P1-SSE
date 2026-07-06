import { app } from '@azure/functions';

// SWA calls this on every login (staticwebapp.config.json "rolesSource").
// It receives the AAD claims for the signed-in user and returns the list of
// SWA roles to grant. We map membership in one Entra security group to the
// "sse-users" role that staticwebapp.config.json requires for every route.
//
// Prerequisites:
//  - SSE_ENTRA_GROUP_ID app setting = object id of the allowed security group
//  - the Entra app registration must emit the "groups" claim
//    (App registration → Token configuration → Add groups claim)
app.http('GetRoles', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'GetRoles',
  handler: async (request, context) => {
    const targetGroupId = process.env.SSE_ENTRA_GROUP_ID;
    if (!targetGroupId) {
      // Fail closed: without the group id configured, nobody gets the role.
      context.error('SSE_ENTRA_GROUP_ID app setting is not configured — denying all role grants.');
      return { jsonBody: { roles: [] } };
    }

    const payload = await request.json();
    const claims = payload?.claims || [];
    const groupIds = claims.filter((c) => c.typ === 'groups').map((c) => c.val);
    const roles = groupIds.includes(targetGroupId) ? ['sse-users'] : [];

    return { jsonBody: { roles } };
  },
});
