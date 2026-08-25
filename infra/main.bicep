// ============================================================================
// P1-SSE — Azure infrastructure
//
// Replaces the Supabase + static-page stack:
//   Static page on a shared host   → Azure Static Web Apps (React/Vite build)
//   Supabase Postgres (app_rates,  → a database on the SHARED PostgreSQL server,
//     cr_* tables)                    the same one the estimator and F.R.E.D use
//   Supabase Storage bucket        → Azure Storage (Blob)
//   Supabase Auth accounts         → Entra ID via Static Web Apps authentication
//
// SHARED resources this template CONSUMES but does not create:
//
//   PostgreSQL — the shared Flexible Server. SSE gets its own DATABASE and its own
//   role on it, isolated from the estimator's and F.R.E.D's exactly as they are
//   from each other. Nothing here manages the server, so a mistake in this
//   template cannot affect a live app. Creating the database and granting the role
//   is a one-time documented step using db/schema.pg.sql + scripts/grant-roles.mjs,
//   the same playbook as F.R.E.D.
//
// WHY A LINKED FUNCTION APP AND NOT SWA'S MANAGED FUNCTIONS
//
// Static Web Apps' managed functions support managed identity ONLY for reading
// Key Vault secrets — not for reaching other Azure resources. The shared PostgreSQL
// servers have password authentication disabled entirely, so a token is the only
// way in and there is no connection string to fall back to. Managed functions
// therefore cannot talk to the database at all.
//
// A "bring your own" Function App has a full system-assigned identity, which is
// what makes passwordless PostgreSQL possible. It costs an extra Function App and
// storage account on Consumption, where this volume sits inside the free grant.
// Linked backends require the SWA Standard tier.
//
// Security posture (deliberate, do not weaken without review):
//   - No database password exists anywhere. The Function App reaches PostgreSQL
//     with its managed identity; the server has password auth disabled.
//   - Storage shared-key access is DISABLED — Entra RBAC only, no account keys.
//     Change-request attachments are read by streaming through the API or with a
//     user-delegation SAS, never an account-key SAS.
//   - Every route requires an authenticated user carrying the sse-users role; see
//     staticwebapp.config.json.
//   - The only secret is the Entra sign-in client secret, held as an SWA app
//     setting. There is no SQL admin password because there is no SQL admin.
//
// Owned by Solid Networks — application developers should not modify or deploy
// this file; request infrastructure changes instead.
// ============================================================================

@description('Deployment environment. Controls SKUs and naming.')
@allowed(['dev', 'prod'])
param environmentName string

param location string = resourceGroup().location

// ── Shared PostgreSQL (consumed, never managed here) ────────────────────────
@description('FQDN of the SHARED PostgreSQL Flexible Server. Shared with the estimator and F.R.E.D and live — nothing in this template touches it.')
param postgresFqdn string

@description('Name of SSE\'s own database on that shared server. Created once by hand, not by this template.')
param postgresDatabase string = 'sse'

// ── Identity / auth ─────────────────────────────────────────────────────────
@description('Client ID of the Entra app registration used for sign-in.')
param aadClientId string = ''

@description('Sign-in client secret. Held as an SWA application setting.')
@secure()
param aadClientSecret string = ''

@description('Object id of the Entra security group allowed into the app. getRoles fails CLOSED when this is unset, so an unconfigured environment admits nobody rather than everybody.')
param sseUsersGroupObjectId string = ''

@description('Object id of the Entra group whose members may change a change-request status. Replaces the cr_profiles.is_developer column, which the applicants themselves could write to.')
param sseDevelopersGroupObjectId string = ''

@description('Which product row in the rate tables this environment serves.')
param productTag string = 'sse'

@description('Repository the SWA builds from. Empty leaves the SWA unlinked so CI deploys with a token instead.')
param repositoryUrl string = ''

param tags object = {
  project: 'p1-sse'
  environment: environmentName
  managedBy: 'solid-networks'
}

var isProd = environmentName == 'prod'
var envLower = toLower(environmentName)

// Storage account names: lowercase alphanumeric, <=24 chars.
var staticWebAppName = 'p1sse-swa-${envLower}'
var functionAppName  = 'p1sse-api-${envLower}'
var planName         = 'p1sse-plan-${envLower}'
var storageName      = 'p1ssestor${envLower}'
var attachmentsContainerName = 'change-requests'

// ── Static Web App ──────────────────────────────────────────────────────────
// Standard, not Free: linked backends require it, and a linked backend is the only
// way the API gets a managed identity (see the header).
resource staticWebApp 'Microsoft.Web/staticSites@2023-12-01' = {
  name: staticWebAppName
  location: location
  tags: tags
  sku: {
    name: 'Standard'
    tier: 'Standard'
  }
  properties: {
    // Deployed by CI with a token rather than by SWA's own GitHub integration, so
    // the build is the same one that ran the tests.
    repositoryUrl: empty(repositoryUrl) ? null : repositoryUrl
    buildProperties: {
      appLocation: '/'
      apiLocation: ''      // the API is the LINKED Function App below, not /api
      outputLocation: 'dist'
    }
    stagingEnvironmentPolicy: isProd ? 'Disabled' : 'Enabled'
    allowConfigFileUpdates: true
  }
}

// The sign-in secret lives here. SWA resolves clientSecretSettingName against
// these settings; staticwebapp.config.json cannot hold a secret itself.
resource swaSettings 'Microsoft.Web/staticSites/config@2023-12-01' = {
  parent: staticWebApp
  name: 'appsettings'
  properties: {
    AAD_CLIENT_ID: aadClientId
    AAD_CLIENT_SECRET: aadClientSecret
  }
}

// ── Storage: change-request attachments, and the Function App's own state ───
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  tags: tags
  sku: {
    name: isProd ? 'Standard_ZRS' : 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    // Entra RBAC only. An account key would be a password by another name, and it
    // is the thing that makes an accidentally-shared SAS URL permanent.
    allowSharedKeyAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: isProd ? 30 : 7
    }
  }
}

// Attachments keep the legacy "<requestId>/<timestamp>-<n>-<name>" path shape, so
// objects can be copied across from the Supabase bucket without rewriting paths.
resource attachments 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: attachmentsContainerName
  properties: {
    publicAccess: 'None'
  }
}

// ── Function App (the linked backend) ───────────────────────────────────────
// Consumption. This workload is a handful of requests per estimator per day, which
// sits well inside the free grant; a dedicated plan would cost more than the rest
// of the app combined.
resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  tags: tags
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  properties: {
    reserved: true   // Linux
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    // The whole reason this app exists rather than SWA's managed functions: this
    // identity is what authenticates to PostgreSQL and to Blob.
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      // Node 20 reached end of life on 2026-04-30 and receives no further security
      // updates. 22 is the current Azure Functions LTS target.
      linuxFxVersion: 'Node|22'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      // The SWA is the only legitimate caller; it proxies /api to this backend.
      cors: {
        allowedOrigins: [
          'https://${staticWebApp.properties.defaultHostname}'
        ]
        supportCredentials: false
      }
      appSettings: [
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~22' }
        // Identity-based storage for the Function App's own bookkeeping — no
        // AzureWebJobsStorage connection string, so no account key anywhere.
        { name: 'AzureWebJobsStorage__accountName', value: storage.name }
        { name: 'AzureWebJobsStorage__credential', value: 'managedidentity' }

        // PostgreSQL. No password: PGUSER is this app's own identity, which is also
        // its PostgreSQL role name, and api/src/db.js exchanges an Entra token for
        // the connection.
        { name: 'PGHOST', value: postgresFqdn }
        { name: 'PGPORT', value: '5432' }
        { name: 'PGDATABASE', value: postgresDatabase }
        { name: 'PGUSER', value: functionAppName }
        // Consumption scales out by adding instances, each with its own pool, and
        // three apps share this server's connection budget.
        { name: 'PGPOOL_MAX', value: '4' }

        // Blob, for change-request attachments.
        { name: 'AZURE_STORAGE_ACCOUNT_URL', value: storage.properties.primaryEndpoints.blob }
        { name: 'AZURE_STORAGE_CONTAINER', value: attachmentsContainerName }

        { name: 'PRODUCT_TAG', value: productTag }
        { name: 'SSE_ENTRA_GROUP_ID', value: sseUsersGroupObjectId }
        { name: 'SSE_DEVELOPERS_GROUP_ID', value: sseDevelopersGroupObjectId }
        { name: 'APP_ENV', value: environmentName }
      ]
    }
  }
}

// Attaches the Function App as the SWA's /api. Without this the SWA serves the
// static build only and every /api call 404s.
resource linkedBackend 'Microsoft.Web/staticSites/linkedBackends@2023-12-01' = {
  parent: staticWebApp
  name: 'api'
  properties: {
    backendResourceId: functionApp.id
    region: location
  }
}

// ── Role assignments for the Function App's identity ────────────────────────
// Storage Blob Data Contributor: read and write attachments. Scoped to this
// storage account, not the resource group.
var roleBlobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource blobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, functionApp.id, roleBlobDataContributor)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleBlobDataContributor)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── Outputs ─────────────────────────────────────────────────────────────────
output staticWebAppName string = staticWebApp.name
output staticWebAppHostname string = staticWebApp.properties.defaultHostname
output functionAppName string = functionApp.name
output functionAppPrincipalId string = functionApp.identity.principalId
output storageAccountName string = storage.name
output attachmentsContainer string = attachmentsContainerName

// The PostgreSQL role is NOT created by this template — the server is shared and
// deliberately outside its blast radius, exactly as with F.R.E.D.
output postDeploy string = 'Next: (1) add https://${staticWebApp.properties.defaultHostname}/.auth/login/aad/callback to the Entra app registration, (2) on the SHARED PostgreSQL server create database "${postgresDatabase}", apply db/schema.pg.sql, then grant this app\'s identity its own role: "node scripts/grant-roles.mjs --app ${functionAppName} --db ${postgresDatabase}" (it authenticates as its own managed identity and must not reach any other app\'s database), (3) set the SWA deployment token in GitHub and push. See README.md.'
