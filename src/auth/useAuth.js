import { useEffect, useState } from 'react';

// Reads the identity SWA injects once Entra SSO succeeds.
// See: https://learn.microsoft.com/azure/static-web-apps/user-information
export function useAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/.auth/me')
      .then((r) => r.json())
      .then((data) => {
        const principal = data?.clientPrincipal || null;
        setUser(principal);
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  return { user, loading };
}

export function loginUrl() {
  return '/.auth/login/aad?post_login_redirect_uri=/';
}

export function logoutUrl() {
  return '/.auth/logout?post_logout_redirect_uri=/';
}
