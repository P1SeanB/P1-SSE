import sql from 'mssql';

let poolPromise;

// Reuses one connection pool across warm Function invocations.
// SQL_CONNECTION_STRING is an SWA/Functions app setting (never in source).
// Use "Authentication=Active Directory Managed Identity" so no password or
// secret exists anywhere — the Function App's managed identity authenticates
// directly to Azure SQL.
export function getPool() {
  const connStr = process.env.SQL_CONNECTION_STRING;
  if (!connStr) {
    throw new Error(
      'SQL_CONNECTION_STRING app setting is not configured. ' +
      'Set it on the Static Web App (Configuration → Application settings).'
    );
  }
  if (!poolPromise) {
    poolPromise = sql.connect(connStr);
  }
  return poolPromise;
}
