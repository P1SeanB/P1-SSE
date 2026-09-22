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
// Matches the estimator's and F.R.E.D's naming, which is title-cased per environment.
var workspaceName    = 'LegaC-SSE-Logs-${environmentName == 'prod' ? 'Prod' : 'Dev'}'
var insightsName     = 'p1sse-ai-${envLower}'
// Matches the estimator's and F.R.E.D's vault naming.
var keyVaultName     = 'legac-sse-kv-${envLower}'
var attachmentsContainerName = 'change-requests'

// ── Static Web App ──────────────────────────────────────────────────────────
// Standard, not Free: linked backends require it, and a linked backend is the only
// way the API gets a managed identity (see the header).
resource staticWebApp 'Microsoft.Web/staticSites@2023-12-01' = {
  name: staticWebAppName
  location: location
  tags: tags
  identity: {
    // Required to resolve the Key Vault reference below. Static Web Apps uses its
    // managed identity for exactly one thing — fetching AUTH secrets from a vault —
    // so this grants nothing else.
    type: 'SystemAssigned'
  }
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
    // A REFERENCE, not the secret. SWA resolves this with its managed identity at
    // sign-in time, so the value is no longer readable from the app settings.
    //
    // ALWAYS a reference, never a conditional. Making it fall back to the literal
    // meant a routine redeploy that omitted the parameter — which is most of them —
    // silently blanked the setting and broke sign-in. Pointing at the vault
    // unconditionally means a redeploy without the secret changes nothing, because the
    // value already lives in the vault.
    AAD_CLIENT_SECRET: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/aad-client-secret/)'
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

// ── Observability ───────────────────────────────────────────────────────────
// Created here rather than by hand, because an app with no telemetry cannot be
// diagnosed at all. When sign-in was failing there was nothing to read: no log store,
// no request counts, no way to tell 'the function returned no roles' apart from 'the
// function was never called'. Those are opposite problems with the same symptom.
resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: insightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
  }
}

// Flex Consumption pushes the built package here and mounts it. Separate from the
// attachments container so a deployment artefact and a customer's file never share
// a blob prefix or a lifecycle rule.
resource deployments 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'deployments'
  properties: {
    publicAccess: 'None'
  }
}

// ── Key Vault for the sign-in secret ────────────────────────────────────────
// The estimator already does this (legac-estimator-kv-dev, secret 'aad-client-secret'),
// so this mirrors it rather than inventing a second pattern.
//
// WHAT THIS DOES AND DOES NOT BUY. It stops the client secret being readable in the
// Static Web App's application settings, and gives one place to replace it. It does
// NOT rotate anything: an Entra app secret is minted by Entra, and a vault only holds
// a copy. It expires on the same date either way — npm run audit:credentials is what
// keeps that from being a surprise.
//
// RBAC rather than access policies, matching the estimator's vault.
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    // A deleted secret is recoverable for 90 days. Purge protection is deliberately
    // left off on dev so a mistake can be cleaned up; prod keeps it, because the point
    // of prod is that a mistake cannot quietly erase the record.
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: isProd ? true : null
  }
}

// Written by the deploy, so the secret reaches the vault without anyone pasting it
// into a portal. Only when one was supplied: a deploy that omits it must not blank an
// existing secret.
resource aadSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(aadClientSecret)) {
  parent: keyVault
  name: 'aad-client-secret'
  properties: {
    value: aadClientSecret
    attributes: {
      enabled: true
    }
  }
}

// Key Vault Secrets User — read a secret's VALUE, nothing else. Not Secrets Officer,
// which could also write and delete.
var roleKeyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'

resource swaVaultRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, staticWebApp.id, roleKeyVaultSecretsUser)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleKeyVaultSecretsUser)
    principalId: staticWebApp.identity.principalId
    principalType: 'ServicePrincipal'
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
  // FLEX CONSUMPTION, matching the estimator. Not Y1 Dynamic: that plan has no
  // writable wwwroot and deploys only via a package blob whose pointer is minted with
  // an ACCOUNT KEY. Shared-key access is disabled on this account, so a Y1 app here
  // cannot be deployed at all — it fails with 'Malformed SCM_RUN_FROM_PACKAGE' after a
  // build that looks like it succeeded.
  //
  // Flex deploys from a blob container authenticated by MANAGED IDENTITY, so the key
  // stays disabled and no second storage account is needed.
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
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
    // Flex declares its runtime and deployment HERE, not via linuxFxVersion or the
    // FUNCTIONS_* app settings. Setting both is rejected, not ignored.
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}${deployments.name}'
          authentication: {
            // No key, no connection string — the whole reason for Flex here.
            type: 'SystemAssignedIdentity'
          }
        }
      }
      scaleAndConcurrency: {
        // A few requests per estimator per day. The memory floor exists so a cold
        // start is not also a memory-starved one.
        maximumInstanceCount: 40
        instanceMemoryMB: 2048
      }
      runtime: {
        name: 'node'
        version: '22'
      }
    }
    siteConfig: {
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
        // FUNCTIONS_EXTENSION_VERSION, FUNCTIONS_WORKER_RUNTIME and
        // WEBSITE_NODE_DEFAULT_VERSION are deliberately absent: on Flex the runtime is
        // declared in functionAppConfig above and these are rejected.
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
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insights.properties.ConnectionString }
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
// Storage Blob Data OWNER, not Contributor. Contributor is enough to read and write
// attachments, but Flex Consumption also writes and mounts its deployment package
// through this identity and needs Owner on the container to do it. This matches what
// the estimator's function app already holds.
var roleBlobDataOwner = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'

resource blobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, functionApp.id, roleBlobDataOwner)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleBlobDataOwner)
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
