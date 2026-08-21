// P1-SSE — core infrastructure: Static Web App + Azure SQL (serverless).
// Deploy: az deployment group create -g <rg> -f infra/main.bicep -p @infra/main.parameters.json

@description('Short name used to derive resource names, e.g. p1sse')
param appName string = 'p1sse'

@description('Azure region for all resources')
param location string = resourceGroup().location

@description('Environment tag, e.g. prod, staging')
param environment string = 'prod'

@description('SQL admin login for initial provisioning only — day-to-day access uses managed identity + Entra auth')
param sqlAdminLogin string

@secure()
@description('SQL admin password for initial provisioning only')
param sqlAdminPassword string

@description('Object ID of the Entra security group allowed to administer the SQL server via Entra auth')
param sqlEntraAdminGroupObjectId string

@description('Display name of the Entra security group set as SQL Entra admin')
param sqlEntraAdminGroupName string

var staticWebAppName = '${appName}-swa-${environment}'
var sqlServerName = '${appName}-sql-${environment}'
var sqlDatabaseName = '${appName}db'

resource staticWebApp 'Microsoft.Web/staticSites@2023-12-01' = {
  name: staticWebAppName
  location: location
  sku: {
    name: 'Standard'
    tier: 'Standard'
  }
  properties: {
    // Repo/branch are linked separately (az staticwebapp update or portal) once
    // the GitHub connection + deployment token are set up.
    provider: 'GitHub'
    buildProperties: {
      appLocation: '/'
      apiLocation: 'api'
      outputLocation: 'dist'
    }
  }
  identity: {
    type: 'SystemAssigned'
  }
}

resource sqlServer 'Microsoft.Sql/servers@2023-08-01-preview' = {
  name: sqlServerName
  location: location
  properties: {
    administratorLogin: sqlAdminLogin
    administratorLoginPassword: sqlAdminPassword
    administrators: {
      administratorType: 'ActiveDirectory'
      principalType: 'Group'
      login: sqlEntraAdminGroupName
      sid: sqlEntraAdminGroupObjectId
      tenantId: subscription().tenantId
      azureADOnlyAuthentication: false
    }
  }
}

resource sqlDatabase 'Microsoft.Sql/servers/databases@2023-08-01-preview' = {
  parent: sqlServer
  name: sqlDatabaseName
  location: location
  sku: {
    name: 'GP_S_Gen5_1'
    tier: 'GeneralPurpose'
    family: 'Gen5'
    capacity: 1
  }
  properties: {
    autoPauseDelay: 60 // minutes idle before pausing billing
    minCapacity: json('0.5')
    zoneRedundant: false
  }
}

// Allow Azure services (incl. the SWA-managed Function App) to reach the server.
resource allowAzureServices 'Microsoft.Sql/servers/firewallRules@2023-08-01-preview' = {
  parent: sqlServer
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

output staticWebAppHostname string = staticWebApp.properties.defaultHostname
output staticWebAppName string = staticWebApp.name
output sqlServerFqdn string = sqlServer.properties.fullyQualifiedDomainName
output sqlDatabaseName string = sqlDatabase.name
