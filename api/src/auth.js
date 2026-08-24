// Who is calling, and may they do this?
//
// Static Web Apps authenticates every request before it reaches a function — see
// staticwebapp.config.json, where each route requires the sse-users role — and
// forwards the result in the x-ms-client-principal header. So a handler never has
// to verify a token or trust anything from the body or query string.
//
// NOTHING HERE VALIDATES A CREDENTIAL, and nothing should. The platform already
// did. If a change here starts looking like authentication, it is in the wrong
// place: this file only reads what the platform decided.
const PRINCIPAL_HEADER = 'x-ms-client-principal';

// The Entra object id arrives as a claim, not as the principal's userId. SWA's
// userId is its OWN stable identifier for the user, which is not the oid and does
// not match anything in Entra — so a row written with it could never be correlated
// back to a person, or to the same person in F.R.E.D or the estimator. Both spellings
// appear depending on the token version.
const OID_CLAIMS = [
  'http://schemas.microsoft.com/identity/claims/objectidentifier',
  'oid',
];
const EMAIL_CLAIMS = [
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'preferred_username',
  'email',
  'upn',
];
const NAME_CLAIMS = [
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
  'name',
];

export const ROLE_USER = 'sse-users';
export const ROLE_DEVELOPER = 'sse-developers';

function claimValue(claims, names) {
  for (const name of names) {
    const hit = claims.find((c) => (c.typ || c.type) === name);
    if (hit && (hit.val || hit.value)) return hit.val || hit.value;
  }
  return '';
}

/**
 * The signed-in user, or null when the header is absent (local development, or a
 * route someone has mistakenly left unprotected).
 *
 * @returns {{oid: string, email: string, name: string, roles: string[]} | null}
 */
export function getUser(request) {
  const header = request.headers.get(PRINCIPAL_HEADER);
  if (!header) return null;

  let principal;
  try {
    principal = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    // A malformed header is not an anonymous user — it is a broken request, and
    // treating it as anonymous would be the wrong direction to fail in.
    return null;
  }

  const claims = principal.claims || [];
  const oid = claimValue(claims, OID_CLAIMS) || principal.userId || '';
  if (!oid) return null;

  return {
    oid,
    email: claimValue(claims, EMAIL_CLAIMS) || principal.userDetails || '',
    name: claimValue(claims, NAME_CLAIMS) || principal.userDetails || '',
    roles: principal.userRoles || [],
  };
}

/**
 * Use at the top of any handler that writes, or that reads something not everyone
 * should see. Returns the user, or a response to return immediately.
 *
 *   const { user, denied } = requireRole(request, ROLE_DEVELOPER);
 *   if (denied) return denied;
 *
 * 401 when we cannot tell who they are, 403 when we can and they may not — the
 * distinction matters to whoever reads the logs.
 */
export function requireRole(request, role = ROLE_USER) {
  const user = getUser(request);
  if (!user) {
    return {
      user: null,
      denied: {
        status: 401,
        jsonBody: { error: 'Not signed in.' },
      },
    };
  }
  if (role && !user.roles.includes(role)) {
    return {
      user,
      denied: {
        status: 403,
        jsonBody: {
          error:
            role === ROLE_DEVELOPER
              ? 'That action is limited to the development team.'
              : 'Your account does not have access to this.',
        },
      },
    };
  }
  return { user, denied: null };
}
