// AFRIKANADOLLZ booking system infrastructure
// Static Web App (site hosting) + a standalone "bring your own" Function App (API + timer-triggered
// SMS reminders, in one deployable unit) + Postgres Flexible Server (DB) + Communication Services
// (Email via an Azure-managed domain that's pre-verified with no DNS work; SMS resource is created
// here but a phone number + A2P 10DLC campaign registration still need to be done manually afterward
// in the portal, since that requires real business info only the site owner can provide).
//
// AI Stylist addition (Azure OpenAI): a Microsoft.CognitiveServices/accounts resource (kind: 'OpenAI')
// + a gpt-5-mini model deployment, backing the opt-in "AI style suggestions" feature on tryon.html
// (src/functions/styleSuggest.js). Verified empirically before deploying:
//   - `az cognitiveservices account list-skus --kind OpenAI --location <region>` showed S0/Standard
//     available in centralus, westus3 AND eastus2 for this subscription -- centralus used, consistent
//     with every other resource here.
//   - `az cognitiveservices model list --location centralus` confirmed gpt-5-mini
//     (OpenAI.gpt-5-mini.2025-08-07) is GenerallyAvailable, chatCompletion-capable, and offered on the
//     GlobalStandard SKU for THIS subscription in centralus (not just "exists somewhere" -- this is the
//     subscription-scoped model catalog, i.e. real deployability, not just a SKU listing). gpt-5-mini
//     was picked over gpt-4o-mini because gpt-4o-mini is already flagged "Deprecating" in that catalog
//     (inference retirement replacement already scheduled) while gpt-5-mini is fresh GA with a 2027
//     deprecation horizon. Per Microsoft Learn's vision-enabled-models doc, the whole GPT-5 family
//     (including -mini) is natively multimodal (accepts image_url content parts on Chat Completions),
//     same as GPT-4o -- no separate "vision SKU" exists anymore.
//   - Azure OpenAI access itself: as of this deployment it's self-service for non-limited-access models
//     (gpt-5-mini is not a Limited Access model) on a normal Pay-As-You-Go subscription -- no separate
//     aka.ms/oai/access gating form needed, unlike the historical (pre-2024) fully-gated preview period.
//
// Background removal (Azure AI Vision) -- explicitly NOT added, and this is intentional, not an
// oversight: Azure AI Image Analysis 4.0's Segment API / "Background removal" feature (the thing that
// would have backed tools/remove-background.js) was retired by Microsoft on 2025-03-31. Confirmed via
// Microsoft's own current docs (concept-background-removal.md: "This feature is now retired... API
// calls to these services will fail") and by the fact the current GA Computer Vision REST API's
// operation groups (Datasets, Image Analysis, Image Composition, Image Retrieval, Model Evaluations,
// Models, Planogram Compliance, Product Recognition) contain no Segment/background-removal group at
// all -- it only ever existed in now-dead 4.0 *preview* API versions. No amount of region/SKU
// workaround fixes a retired API, so no Computer Vision/Vision resource is deployed here for this
// purpose (would just be paying for infrastructure that 404s). See tools/remove-background.js's header
// comment for what was built instead and why.

@description('Short project name used as a prefix for resource names')
param projectName string = 'afrikanadollz'

@description('Azure region for all resources')
param location string = resourceGroup().location

@description('Postgres administrator login name')
param dbAdminUser string = 'afdadmin'

@secure()
@description('Postgres administrator password')
param dbAdminPassword string

@description('Communication Services / Email data location (a broad geography, not a region)')
param acsDataLocation string = 'United States'

// These three default to a value derived from the resource group's own id, so they're STABLE across
// every future redeploy without needing to be passed explicitly -- previously these lived only as
// out-of-band `az functionapp config appsettings set` values, which got silently dropped the next
// time this template was deployed (Microsoft.Web/sites siteConfig.appSettings is replaced wholesale
// by an ARM deployment, not merged with whatever was set outside it), quietly breaking admin/customer
// login. Being real Bicep params with a real default fixes that permanently: as long as nobody passes
// an override, `uniqueString(...)` recomputes to the exact same value every time.
@secure()
@description('HMAC secret for signing admin session cookies')
param adminSessionSecret string = uniqueString(resourceGroup().id, 'admin-session-v1')

@secure()
@description('HMAC secret for signing customer session cookies')
param customerSessionSecret string = uniqueString(resourceGroup().id, 'customer-session-v1')

@description('Registered admin login email (bootstrap value for db/seed.js; changeable afterward via the admin Forgot Password flow / a direct DB update)')
param adminEmail string = 'admin@afrikanadollz.com'

var suffix = uniqueString(resourceGroup().id)
var storageAccountName = toLower('afdfn${take(suffix, 16)}')
var funcPlanName = '${projectName}-api-plan'
var funcAppName = '${projectName}-api-${suffix}'
var appInsightsName = '${projectName}-insights'
var staticSiteName = '${projectName}-web'
var pgServerName = toLower('${projectName}-db-${suffix}')
var pgDatabaseName = 'afrikanadollz'
var acsName = '${projectName}-acs'
var emailServiceName = '${projectName}-email'
var emailDomainName = 'AzureManagedDomain'
var openaiName = toLower('${projectName}-openai-${suffix}')
var openaiStyleDeploymentName = 'gpt-5-mini'

resource storage 'Microsoft.Storage/storageAccounts@2025-06-01' = {
  name: storageAccountName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
  }
}

// ---- Inspiration-photo uploads (booking form's optional photo field) ----
// A SEPARATE container on the SAME storage account used above for the Functions runtime's own
// AzureWebJobsStorage -- not that internal container, per the task's explicit instruction to keep the
// two uses apart. Since allowBlobPublicAccess is false at the account level (above), this container can
// never be made publicly readable regardless of its own publicAccess setting -- src/functions/
// uploadInspirationPhoto.js hands back a SAS-signed URL instead. See that file's header comment and the
// task report for the blob-retention/cleanup consideration this implies.
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2025-06-01' = {
  parent: storage
  name: 'default'
}

resource inspirationPhotosContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01' = {
  parent: blobService
  name: 'inspiration-photos'
  properties: {
    publicAccess: 'None'
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
  }
}

resource funcPlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: funcPlanName
  location: location
  sku: { name: 'Y1', tier: 'Dynamic' }
  kind: 'functionapp'
  properties: { reserved: true }
}

resource funcApp 'Microsoft.Web/sites@2023-12-01' = {
  name: funcAppName
  location: location
  kind: 'functionapp,linux'
  properties: {
    serverFarmId: funcPlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'Node|20'
      // Explicit CORS restriction -- a security audit (2026-08) found no `cors` block here at all.
      // Verified empirically against the live resource (`az rest` against
      // .../config/web?api-version=2023-12-01`, properties.cors) that this was NOT silently wide-open:
      // an unset `cors` property returns `null`, and no src/functions/*.js handler sets its own
      // Access-Control-Allow-Origin header either, so the platform emits NO CORS header at all today --
      // a browser making a genuine cross-origin fetch straight at the raw
      // afrikanadollz-api-*.azurewebsites.net hostname gets no ACAO header and is blocked client-side.
      // That's the secure failure mode, not a `*` wildcard. It's also largely moot in practice: this
      // site never calls the raw Function App origin from browser JS -- it always calls same-origin
      // `/api/*` against the Static Web App, which forwards server-to-server via the `linkedBackends`
      // link below (server-to-server calls aren't subject to browser CORS at all).
      // Still adding this explicitly rather than leaving it unset: relying on "nobody configured CORS
      // so it defaults to closed" is fragile (a future portal click to unblock a CORS error while
      // debugging, e.g. setting it to `*`, would combine badly with this app's cookie-based admin/
      // customer sessions -- credentialed CORS + `*` origin is a real, well-known exposure). Being
      // explicit here bounds that. `supportCredentials: true` matches that cookies ARE used
      // (ADMIN_SESSION_SECRET/CUSTOMER_SESSION_SECRET-signed session cookies), should this origin ever
      // be called directly with credentials. allowedOrigins is just the site's real origin(s) --
      // confirmed via `az staticwebapp hostname list` that no custom domain is bound yet (empty result),
      // so only the default SWA hostname is listed for now; add the custom domain here once
      // afrikanadollz.com is actually bound to the Static Web App resource.
      //
      // NOT applied to live Azure by this change -- see the big warning block below about
      // `az deployment group create` against this template wiping other settings if not done
      // carefully. This needs a deliberate, careful redeploy by a human, not an automatic one.
      cors: {
        allowedOrigins: [
          'https://${staticSite.properties.defaultHostname}'
        ]
        supportCredentials: true
      }
      appSettings: [
        { name: 'AzureWebJobsStorage', value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=core.windows.net' }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' }
        { name: 'APPINSIGHTS_INSTRUMENTATIONKEY', value: appInsights.properties.InstrumentationKey }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
        // App-specific settings below are placeholders -- real values are filled in post-deploy
        // once the Postgres/ACS resources' actual connection strings and a real business inbox
        // /verified sender are known. Values here just keep the app from crashing on cold start.
        //
        // ******************************************************************************************
        // IMPORTANT / LEARNED THE HARD WAY: `siteConfig.appSettings` is authoritative, not a merge --
        // deploying this template REPLACES the Function App's entire app-settings list with exactly
        // what's declared below. Any setting configured post-deploy via `az functionapp config
        // appsettings set` (i.e. NOT declared here) gets silently WIPED on the next `az deployment
        // group create` against this file -- this already happened once (ADMIN_SESSION_SECRET/
        // CUSTOMER_SESSION_SECRET/ADMIN_PASSWORD/ADMIN_EMAIL vanished, breaking live admin auth with a
        // 500, after an unrelated infra change for the inspiration-photos container). The fix in both
        // directions: (1) once a value below is confirmed correct in production (e.g.
        // ACS_EMAIL_FROM_ADDRESS was fixed live from its placeholder to the real managed-domain
        // sender), update the value HERE too, don't leave the placeholder stale in source -- otherwise
        // the next redeploy silently regresses it back to the placeholder. (2) for anything that
        // can't/shouldn't be a real value in source control (session-signing secrets, the admin
        // password), keep the placeholder here so a from-scratch deploy doesn't hard-crash, but budget
        // a "restore real values via `az functionapp config appsettings set`" pass as a mandatory
        // follow-up step after ANY future `az deployment group create` against this template.
        //
        // SECOND-ORDER CONSEQUENCE OF THE SAME ROOT CAUSE (also learned the hard way, right after
        // fixing the first one): `WEBSITE_RUN_FROM_PACKAGE` and `WEBSITE_MOUNT_ENABLED` are set by
        // `func azure functionapp publish` itself (WEBSITE_RUN_FROM_PACKAGE is a short-lived SAS URL
        // pointing at that specific deploy's code package zip) -- they are NOT declared anywhere in
        // this template, on purpose, since a SAS URL baked into source would just be wrong/expired
        // immediately. That means a bicep deploy wipes THESE too, same as any other undeclared
        // setting, and the Function App silently has no code to run -- EVERY route 404s, not just the
        // ones covered by the fix above (this actually happened, right after adding
        // adminSessionSecret/customerSessionSecret/adminEmail as real params to fix the first
        // instance of this class of bug). There is no template-level fix for this half -- it's not a
        // secret that can be given a stable default. The mandatory step is procedural:
        // **immediately run `func azure functionapp publish <name>` after ANY `az deployment group
        // create` against this template, no exceptions** -- until that's done, the app has settings
        // but no deployed code.
        // ******************************************************************************************
        { name: 'DATABASE_URL', value: 'postgresql://${dbAdminUser}:${dbAdminPassword}@${pgServer.properties.fullyQualifiedDomainName}/${pgDatabaseName}?sslmode=require' }
        { name: 'ACS_EMAIL_CONNECTION_STRING', value: acsResource.listKeys().primaryConnectionString }
        { name: 'ACS_EMAIL_FROM_ADDRESS', value: 'DoNotReply@${emailDomain.properties.mailFromSenderDomain}' }
        { name: 'BUSINESS_NOTIFY_EMAIL', value: 'REPLACE_ME_diaka_inbox@example.com' }
        { name: 'ACS_SMS_CONNECTION_STRING', value: acsResource.listKeys().primaryConnectionString }
        { name: 'ACS_SMS_FROM_NUMBER', value: 'REPLACE_ME_after_purchasing_a_number' }
        { name: 'SITE_BASE_URL', value: 'https://${staticSite.properties.defaultHostname}' }
        // Session-signing secrets and the admin bootstrap credential -- deliberately kept as
        // placeholders in source (see the block comment above): a real random secret has no business
        // living in a committed file, and the seed-time-only ADMIN_PASSWORD isn't sensitive to *which*
        // value is here since login checks admin_account's DB-stored hash, not this env var -- but
        // both still need a real value set live via CLI after every deploy of this template, or
        // ADMIN_SESSION_SECRET/CUSTOMER_SESSION_SECRET being a placeholder will break auth outright
        // (missing entirely 500s; a placeholder string technically "works" but is a real secret-
        // hygiene problem, so treat "still the bicep placeholder" as equally broken and fix it).
        // Real, stable values now (not REPLACE_ME placeholders) via the adminSessionSecret/
        // customerSessionSecret/adminEmail params above -- their defaults are deterministic
        // (uniqueString of the resource group id), so redeploying this template without passing an
        // override reproduces the SAME value every time, closing the wipe-on-redeploy hole for good.
        { name: 'ADMIN_SESSION_SECRET', value: adminSessionSecret }
        { name: 'CUSTOMER_SESSION_SECRET', value: customerSessionSecret }
        { name: 'ADMIN_PASSWORD', value: 'REPLACE_ME_seed_time_only_not_read_by_live_login' }
        { name: 'ADMIN_EMAIL', value: adminEmail }
        // Inspiration-photo uploads (src/functions/uploadInspirationPhoto.js, src/functions/book.js) --
        // same storage account as AzureWebJobsStorage above, but its own connection-string setting
        // (this app code should never assume AzureWebJobsStorage points at a container it's allowed to
        // write app data into) pointed at the dedicated 'inspiration-photos' container declared above.
        // Key-based connection string, not managed identity/RBAC, to match every other credential in
        // this template (DATABASE_URL, ACS_*_CONNECTION_STRING, AZURE_OPENAI_API_KEY) -- introducing
        // managed identity for just this one resource would be an inconsistent one-off.
        // INSPIRATION_PHOTOS_BLOB_ENDPOINT is the real primary blob endpoint (not a hardcoded
        // "*.blob.core.windows.net" guess) -- book.js uses it to verify a client-submitted
        // inspirationPhotoUrl actually points into this container before persisting it.
        { name: 'INSPIRATION_PHOTOS_CONNECTION_STRING', value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=core.windows.net' }
        { name: 'INSPIRATION_PHOTOS_CONTAINER', value: inspirationPhotosContainer.name }
        { name: 'INSPIRATION_PHOTOS_BLOB_ENDPOINT', value: storage.properties.primaryEndpoints.blob }
        // AI Stylist (Azure OpenAI) -- see the header comment for why gpt-5-mini/centralus was picked.
        { name: 'AZURE_OPENAI_ENDPOINT', value: openaiAccount.properties.endpoint }
        { name: 'AZURE_OPENAI_API_KEY', value: openaiAccount.listKeys().key1 }
        { name: 'AZURE_OPENAI_DEPLOYMENT', value: openaiStyleDeploymentName }
        { name: 'AZURE_OPENAI_API_VERSION', value: '2025-01-01-preview' }
        // Shopify connector (index.html's #products section + real checkout) -- backend proxy over
        // the Storefront API, see lib/shopify.js's header comment for why this is a server-side proxy
        // rather than a client-embedded token. No Shopify resource is provisioned by this template --
        // these three are pure config pointing at an EXISTING Shopify store (afrikanadollz.com already
        // resolves to one) and must be filled in with real values from that store's admin before the
        // shop section will show live inventory; until then src/functions/shopify/products.js returns
        // 503 and index.html falls back to its static demo catalogue.
        { name: 'SHOPIFY_STORE_DOMAIN', value: 'REPLACE_ME_yourstorename.myshopify.com' }
        { name: 'SHOPIFY_STOREFRONT_ACCESS_TOKEN', value: 'REPLACE_ME_storefront_access_token_from_shopify_admin' }
        { name: 'SHOPIFY_API_VERSION', value: '2026-07' }
        // Stripe (service-appointment deposits/balances -- see lib/stripe.js). Card data never
        // reaches this backend: the client confirms a PaymentIntent via Stripe.js/Elements, and every
        // handler that trusts "payment succeeded" independently re-verifies status+amount against
        // Stripe's own API server-side rather than a client-supplied flag (see src/functions/book.js
        // and src/functions/payments/*). No Stripe resource is provisioned by this template -- pure
        // config pointing at an externally-created Stripe account, same pattern as the Shopify block
        // above. STRIPE_WEBHOOK_SECRET is the signing secret for the specific webhook endpoint
        // configured in the Stripe dashboard to point at this Function App's /api/payments/webhook.
        { name: 'STRIPE_SECRET_KEY', value: 'REPLACE_ME_sk_test_or_live_from_stripe_dashboard' }
        { name: 'STRIPE_PUBLISHABLE_KEY', value: 'REPLACE_ME_pk_test_or_live_from_stripe_dashboard' }
        { name: 'STRIPE_WEBHOOK_SECRET', value: 'REPLACE_ME_whsec_from_stripe_webhook_endpoint_settings' }
      ]
    }
  }
}

resource pgServer 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' = {
  name: pgServerName
  location: location
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '16'
    administratorLogin: dbAdminUser
    administratorLoginPassword: dbAdminPassword
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
  }
}

resource pgDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2025-08-01' = {
  parent: pgServer
  name: pgDatabaseName
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

// Allow Azure services (incl. this Function App) to reach Postgres. Tighten later to a VNet/private
// endpoint if this ever needs to be more locked-down than a single-operator salon app requires.
resource pgFirewallAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2025-08-01' = {
  parent: pgServer
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource staticSite 'Microsoft.Web/staticSites@2023-12-01' = {
  name: staticSiteName
  location: location
  sku: { name: 'Standard', tier: 'Standard' } // Standard is required to link a bring-your-own Function App
  properties: {
    buildProperties: {
      skipGithubActionWorkflowGeneration: true // deploying the static files by other means (e.g. SWA CLI / manual)
    }
  }
}

resource staticSiteBackendLink 'Microsoft.Web/staticSites/linkedBackends@2023-12-01' = {
  parent: staticSite
  name: 'afrikanadollz-api-backend'
  properties: {
    backendResourceId: funcApp.id
    region: location
  }
}

resource emailService 'Microsoft.Communication/emailServices@2025-09-01' = {
  name: emailServiceName
  location: 'global'
  properties: {
    dataLocation: acsDataLocation
  }
}

// Azure-managed domain: pre-verified, works immediately (sender looks like
// DoNotReply@<random>.azurecomm.net) so email sending can be tested with zero DNS setup.
// A custom domain (e.g. mail.afrikanadollz.com) can be added later once the owner wants a branded
// sender address -- that step needs their own DNS access and isn't something this deployment can do.
resource emailDomain 'Microsoft.Communication/emailServices/domains@2025-09-01' = {
  parent: emailService
  name: emailDomainName
  location: 'global'
  properties: {
    domainManagement: 'AzureManaged'
  }
}

// The domain link lives as a property on the Communication Services resource itself --
// there is no separate "communicationServices/domains" child resource type.
resource acsResource 'Microsoft.Communication/communicationServices@2025-09-01' = {
  name: acsName
  location: 'global'
  properties: {
    dataLocation: acsDataLocation
    linkedDomains: [
      emailDomain.id
    ]
  }
}

// ---- Azure OpenAI (AI Stylist) -- see the header comment for the region/model-availability research ----
resource openaiAccount 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: openaiName
  location: location
  kind: 'OpenAI'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: openaiName // required to get a https://<name>.openai.azure.com data-plane endpoint
    publicNetworkAccess: 'Enabled'
  }
}

// A single vision-capable chat deployment backing styleSuggest.js. GlobalStandard is the standard
// pay-as-you-go SKU (vs. GlobalProvisionedManaged, which pre-commits/reserves throughput -- overkill
// for a low-volume opt-in feature on a single-operator salon site).
resource openaiStyleDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: openaiAccount
  name: openaiStyleDeploymentName
  sku: { name: 'GlobalStandard', capacity: 10 }
  properties: {
    model: { format: 'OpenAI', name: 'gpt-5-mini', version: '2025-08-07' }
  }
}

output functionAppName string = funcApp.name
output functionAppHostname string = funcApp.properties.defaultHostName
output staticWebAppName string = staticSite.name
output staticWebAppHostname string = staticSite.properties.defaultHostname
output staticWebAppDeploymentToken string = staticSite.listSecrets().properties.apiKey
output postgresServerFqdn string = pgServer.properties.fullyQualifiedDomainName
output postgresDatabaseUrl string = 'postgresql://${dbAdminUser}:${dbAdminPassword}@${pgServer.properties.fullyQualifiedDomainName}/${pgDatabaseName}?sslmode=require'
output acsEmailConnectionString string = acsResource.listKeys().primaryConnectionString
output emailManagedDomainName string = emailDomain.properties.mailFromSenderDomain
output openaiEndpoint string = openaiAccount.properties.endpoint
output openaiDeploymentName string = openaiStyleDeploymentName
output openaiApiKey string = openaiAccount.listKeys().key1
