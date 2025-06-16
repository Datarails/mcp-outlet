import { execSync } from "child_process";
import {
  CloudConfig,
  execSyncWithoutThrow,
  FunctionConfig,
  MultiCloudConfig,
  NetworkAccessConfig,
} from "../shared.ts";
import { existsSync } from "fs";

// Base configuration interface
export interface BaseConfig extends CloudConfig, NetworkAccessConfig {
  service: string;
  stage: string;
  version: string;
  resourceGroup: string;
  containerName: string;
  storageAccountName: string;
  cacheStorageAccountName: string;
  cacheStorageSkuName: string;
  nsgRuleName: string;
  allowedSourceAddressPrefixes: string[];
  vnetName: string;
}

// Function App configuration
export interface FunctionAppConfig extends FunctionConfig {
  runtimeStack: string;
  runtimeVersion: string;
  osType: string;
  skuName: string;
  skuTier: string;
  skuFamily: string;
  logLevel: string;
  events?: ApiConfig[];
}

// API Management configuration
export interface ApiConfig {
  apiName: string;
  description: string;
  corsOptions: {
    allowCredentials: boolean;
    allowedOrigins: string[];
    allowedMethods: string[];
    allowedHeaders: string[];
  };
  endpoint: ApiEndpoint;
  skuName: string;
  publisherName: string;
  publisherEmail: string;
}

export interface ApiEndpoint {
  path: string;
  methods: string[];
}

// Outputs configuration
export interface OutputConfig {
  includeApiUrl?: boolean;
  includeFunctionAppName?: boolean;
  includeStorageAccountName?: boolean;
  customOutputs?: Array<{
    name: string;
    value: string;
    description?: string;
  }>;
}

export function validateConfig(config: MultiCloudConfig) {
  console.log("🔍 Validating Azure configuration...");
  if (config.operatingSystem === "linux" && !config.tempFolder) {
    config.tempFolder = "/tmp";
  } else if (
    config.operatingSystem === "linux" &&
    config.tempFolder !== "/tmp"
  ) {
    throw new Error("Linux supported temp folder only /tmp");
  }

  // Basic validation
  if (!config.service || config.service.trim() === "") {
    throw new Error("Service name is required");
  }

  if (!config.stage || config.stage.trim() === "") {
    throw new Error("Stage is required");
  }

  if (!config.cloud.region || config.cloud.region.trim() === "") {
    throw new Error("Azure region is required");
  }

  // Validate functions
  if (!config.functions || config.functions.length === 0) {
    throw new Error("At least one function configuration is required");
  }
  const skuNames = new Set(config.functions.map((v) => v.skuName));
  const skuTiers = new Set(config.functions.map((v) => v.skuTier));
  if (skuNames.size > 1 || skuTiers.size > 1) {
    throw new Error("All functions must have the same skuName and skuTier");
  }

  config.functions.forEach((func, index) => {
    if (!func.name || func.name.trim() === "") {
      throw new Error(`Function ${index} name is required`);
    }

    if (!func.handler || func.handler.trim() === "") {
      throw new Error(`Function ${index} handler is required`);
    }

    if (!func.source || func.source.trim() === "") {
      throw new Error(`Function ${index} source is required`);
    }

    // Validate runtime
    if (!func.runtime || !func.runtime.type || !func.runtime.version) {
      throw new Error(`Function ${index} runtime configuration is incomplete`);
    }

    // Validate events
    if (func.events && func.events.length > 0) {
      func.events.forEach((event, eventIndex) => {
        if (!event.endpoint || !event.endpoint.path) {
          throw new Error(
            `Function ${index} event ${eventIndex} endpoint path is required`
          );
        }

        if (!event.endpoint.methods || event.endpoint.methods.length === 0) {
          throw new Error(
            `Function ${index} event ${eventIndex} must have at least one HTTP method`
          );
        }
      });
    }
  });

  console.log("✅ Azure configuration is valid");
}

export interface BicepDeploymentConfig {
  functionApps: FunctionAppConfig[];
  outputs?: OutputConfig;
  additionalTags?: Record<string, string>;
}

export function generateBicepTemplate(config: {
  base: BaseConfig;
  config: BicepDeploymentConfig;
  subnetIndex: number; // NEW: for unique IP ranges
}): string {
  const { base, config: azureConfig, subnetIndex } = config;

  // Create tags object without duplicates
  const allTags = azureConfig.additionalTags || {};

  // Get the first function app for configuration defaults
  const primaryFunc = azureConfig.functionApps[0];

  // Calculate unique CIDR blocks based on subnetIndex
  const functionSubnetCidr = `10.0.${subnetIndex * 2 + 1}.0/24`;
  const peSubnetCidr = `10.0.${subnetIndex * 2 + 2}.0/24`;

  // Generate Bicep template content matching the working template structure
  const bicepTemplate = `// Azure Function App Bicep Template
// Based on best practices from Voitanos article
// Generated for ${base.service}-${base.stage}

@description('Resource name prefix')
param resourceNamePrefix string = '${base.service}'

@description('The deployment stage')
param stage string = '${base.stage}'

@description('The Azure region')
param location string = '${base.region}'

@description('Enable private networking')
param isPrivate bool = ${base.isPrivate}

@description('The name of the Azure Function app (must be globally unique).')
param functionAppName string = '\${resourceNamePrefix}-\${stage}-${
    primaryFunc.runtimeStack
  }-func-\${uniqueString(resourceGroup().id)}'

@description('URL (HTTPS) of the zipped deployment package – should include SAS if private.')
param packageUri string

@description('Storage Account name and key for deployment.')
param deploymentStorageKey string

@description('Operating system for the Functions hosting plan.')
@allowed([
  'Windows'
  'Linux'
])
param functionPlanOS string = '${primaryFunc.osType}'

@description('Elastic Premium SKU for the hosting plan.')
@allowed([
  'EP1'
  'EP2'
  'EP3'
])
param elasticPremiumSku string = '${primaryFunc.skuName}'

@description('Linux runtime stack in format <runtime>|<version> (Linux only).')
param linuxFxVersion string = '${primaryFunc.runtimeStack.toUpperCase()}|${
    primaryFunc.runtimeVersion
  }'

@description('Function App subnet address prefix')
param functionSubnetAddressPrefix string = '${functionSubnetCidr}'

@description('Private endpoint subnet address prefix')
param privateEndpointSubnetAddressPrefix string = '${peSubnetCidr}'

@description('Existing NSG name (created by deployNetwork)')
param networkSecurityGroupName string = '${base.networkSecurityGroup}'

@description('Existing DNS Zone name (created by deployNetwork)')
param dnsZoneName string = '${base.dnsZoneName}'

@description('Common tags for all resources')
param tags object = {
  ${Object.entries(allTags)
    .map(([key, value]) => `${key}: '${value}'`)
    .join("\n  ")}
}

// Variables - following working template patterns
var isReserved = (functionPlanOS == 'Linux')
var storageAccountName = '${base.storageAccountName}'
var appServicePlanName = '\${functionAppName}-plan'
var applicationInsightsName = '\${functionAppName}-ai'
var vnetName = '${base.vnetName}' 
var privateEndpointName = '\${functionAppName}-pe'

// Reference existing VNet
resource existingVnet 'Microsoft.Network/virtualNetworks@2023-09-01' existing = if (isPrivate) {
  name: vnetName
}

// Reference existing NSG (created by deployNetwork)
resource existingNsg 'Microsoft.Network/networkSecurityGroups@2023-09-01' existing = if (isPrivate) {
  name: networkSecurityGroupName
}

// Reference existing DNS Zone (created by deployNetwork)
resource existingDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' existing = if (isPrivate) {
  name: dnsZoneName
}

// Create subnets separately instead of inline
resource functionSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = if (isPrivate) {
  name: functionAppName
  parent: existingVnet
  properties: {
    addressPrefix: functionSubnetAddressPrefix
    delegations: [
      {
        name: 'Microsoft.Web/serverFarms'
        properties: {
          serviceName: 'Microsoft.Web/serverFarms'
        }
      }
    ]
  }
}

resource peSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = if (isPrivate) {
  name: '\${functionAppName}-pe'
  parent: existingVnet
  properties: {
    addressPrefix: privateEndpointSubnetAddressPrefix
    networkSecurityGroup: {
      id: existingNsg.id
    }
  }
  dependsOn: [functionSubnet]
}

// Shared App Service Plan (Elastic Premium)
resource appServicePlan 'Microsoft.Web/serverfarms@2023-01-01' = {
  name: appServicePlanName
  location: location
  tags: tags
  sku: {
    name: elasticPremiumSku
    tier: '${primaryFunc.skuTier}'
    family: '${primaryFunc.skuFamily}'
  }
  kind: 'elastic'
  properties: {
    reserved: isReserved
    ${
      primaryFunc.maximumElasticWorkerCount
        ? `maximumElasticWorkerCount: ${primaryFunc.maximumElasticWorkerCount}`
        : ""
    }
  }
}

// Application Insights for monitoring - following working template
resource applicationInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: applicationInsightsName
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
  }
}

// Function App for ${primaryFunc.name} - following working template structure
resource functionApp 'Microsoft.Web/sites@2023-01-01' = {
  name: functionAppName
  location: location
  tags: tags
  kind: isReserved ? 'functionapp,linux' : 'functionapp'
  properties: {
    serverFarmId: appServicePlan.id
    reserved: isReserved
    httpsOnly: true
    virtualNetworkSubnetId: isPrivate ? functionSubnet.id : null 
    publicNetworkAccess: isPrivate ? 'Disabled' : 'Enabled'
    vnetRouteAllEnabled: isPrivate ? true : null
    siteConfig: {
      minTlsVersion: '1.2'
      linuxFxVersion: isReserved ? linuxFxVersion : null
      vnetRouteAllEnabled: isPrivate ? true : null
      appSettings: [
        {
          name: 'APPINSIGHTS_INSTRUMENTATIONKEY'
          value: applicationInsights.properties.InstrumentationKey
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: applicationInsights.properties.ConnectionString
        }
        {
          name: 'AzureWebJobsStorage'
          value: 'DefaultEndpointsProtocol=https;AccountName=\${storageAccountName};EndpointSuffix=\${environment().suffixes.storage};AccountKey=\${deploymentStorageKey}'
        }
        {
          name: 'WEBSITE_CONTENTAZUREFILECONNECTIONSTRING'
          value: 'DefaultEndpointsProtocol=https;AccountName=\${storageAccountName};EndpointSuffix=\${environment().suffixes.storage};AccountKey=\${deploymentStorageKey}'
        }
        {
          name: 'WEBSITE_CONTENTSHARE'
          value: toLower(functionAppName)
        }
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: '${primaryFunc.runtimeStack}'
        }
        {
          name: 'WEBSITE_NODE_DEFAULT_VERSION'
          value: '~${primaryFunc.runtimeVersion}'
        }
        {
          name: 'STAGE'
          value: stage
        }
        ${
          primaryFunc.environment
            ? Object.entries(primaryFunc.environment)
                .map(
                  ([key, value]) => `{
          name: '${key}'
          value: '${value}'
        }`
                )
                .join("\n        ")
            : ""
        }
      ]
      ${
        primaryFunc.scaleLimit
          ? `functionAppScaleLimit: ${primaryFunc.scaleLimit}`
          : ""
      }
      cors: {
        allowedOrigins: ['*']
        supportCredentials: false
      }
    }
  }
}

// Private Endpoint (only if private)
resource privateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = if (isPrivate) {
  name: privateEndpointName
  location: location
  tags: tags
  properties: {
    subnet: {
      id: peSubnet.id 
    }
    privateLinkServiceConnections: [
      {
        name: privateEndpointName
        properties: {
          privateLinkServiceId: functionApp.id
          groupIds: ['sites']
        }
      }
    ]
  }
}

// Private DNS Zone Group (only if private)
resource privateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-09-01' = if (isPrivate) {
  name: 'default'
  parent: privateEndpoint
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'config'
        properties: {
          privateDnsZoneId: existingDnsZone.id
        }
      }
    ]
  }
}

resource zipDeploy 'Microsoft.Web/sites/extensions@2021-02-01' = {
  name: '\${functionApp.name}/ZipDeploy'
  properties: {
    packageUri: packageUri
  }
  dependsOn: [
    functionApp
    privateEndpoint
  ]
}

// Outputs
output storageAccountName string = storageAccountName
output applicationInsightsName string = applicationInsights.name
output applicationInsightsInstrumentationKey string = applicationInsights.properties.InstrumentationKey
output functionAppName string = functionApp.name
output functionAppUrl string = 'https://\${functionApp.properties.defaultHostName}'
output privateEndpointIP string = isPrivate ? privateEndpoint.properties.customDnsConfigs[0].ipAddresses[0] : ''
output vnetName string = isPrivate ? existingVnet.name : ''
output packageUri string = packageUri
`;

  return bicepTemplate.trim();
}
export async function uploadDeploymentPackages(
  baseConfig: BaseConfig,
  containerName: string,
  runtime: string
): Promise<string> {
  console.log(`📦 Uploading ${runtime} deployment package to blob storage...`);

  // Upload the runtime-specific deployment package
  const zipPath = `.mcp-outlet/${baseConfig.service}-${baseConfig.stage}-${runtime}.zip`;
  const blobName = `${baseConfig.service}-${baseConfig.stage}-${runtime}.zip`;

  console.log(`📂 Package path: ${zipPath}`);
  console.log(`📂 Blob name: ${blobName}`);
  console.log(`🗄️ Storage account: ${baseConfig.storageAccountName}`);
  console.log(`📁 Container: ${containerName}`);

  // Check if package exists
  if (!existsSync(zipPath)) {
    throw new Error(
      `❌ Package not found: ${zipPath}. Make sure to run 'npm run package' first.`
    );
  }

  // Get storage account key for authentication
  console.log("🔑 Getting storage account key...");
  const storageKeyResult = execSync(
    `az storage account keys list --resource-group "${baseConfig.resourceGroup}" --account-name "${baseConfig.storageAccountName}" --query "[0].value" --output tsv`,
    {
      stdio: "pipe",
      encoding: "utf8",
    }
  );
  const storageKey = storageKeyResult.trim();

  try {
    // Upload zip to blob storage using account key
    console.log(
      `📤 Uploading ${zipPath} to ${baseConfig.storageAccountName}/${containerName}/${blobName}...`
    );
    execSync(
      `az storage blob upload --account-name "${baseConfig.storageAccountName}" --account-key "${storageKey}" --container-name "${containerName}" --name "${blobName}" --file "${zipPath}" --overwrite`,
      {
        stdio: "inherit",
      }
    );
    console.log(`✅ Uploaded ${blobName} to blob storage successfully`);

    // Verify the upload
    console.log("🔍 Verifying upload...");
    const blobList = execSync(
      `az storage blob list --account-name "${baseConfig.storageAccountName}" --account-key "${storageKey}" --container-name "${containerName}" --query "[?name=='${blobName}'].{name:name,size:properties.contentLength}" --output json`,
      {
        stdio: "pipe",
        encoding: "utf8",
      }
    );
    const blobs = JSON.parse(blobList.trim());
    if (blobs.length > 0) {
      console.log(
        `✅ Package verified: ${blobs[0].name} (${blobs[0].size} bytes)`
      );
    } else {
      throw new Error("❌ Package upload verification failed");
    }

    return blobName;
  } catch (error) {
    console.error(`❌ Failed to upload ${blobName}:`, error.message);
    throw error;
  }
}

export async function deployStack(
  baseConfig: BaseConfig,
  tags: Record<string, string>
): Promise<{
  storageKey: string;
  cacheStorageKey: string;
}> {
  try {
    console.log(`📦 Creating resource group: ${baseConfig.resourceGroup}`);
    execSyncWithoutThrow(
      `az group create --name "${baseConfig.resourceGroup}" --location "${
        baseConfig.region
      }" --tags ${Object.entries(tags)
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ")}`,
      {
        stdio: "inherit",
      }
    );
    console.log(
      `🔑 Creating storage account ${baseConfig.storageAccountName} in resource group ${baseConfig.resourceGroup} in region ${baseConfig.region}`
    );
    // Create storage account
    execSyncWithoutThrow(
      `az storage account create --name "${baseConfig.storageAccountName}" --resource-group "${baseConfig.resourceGroup}" --location "${baseConfig.region}" --sku Standard_LRS --kind StorageV2`,
      { stdio: "inherit" }
    );
    // Create container
    execSyncWithoutThrow(
      `az storage container create --name "${baseConfig.containerName}" --account-name "${baseConfig.storageAccountName}" --auth-mode login`,
      { stdio: "inherit" }
    );
    console.log(
      `✅ Storage ${baseConfig.storageAccountName} account and container ${baseConfig.containerName} created`
    );

    // Creating cache storage account
    console.log(
      `🔑 Creating cache storage account ${baseConfig.cacheStorageAccountName} in resource group ${baseConfig.resourceGroup} in region ${baseConfig.region}`
    );

    execSyncWithoutThrow(
      `az storage account create --resource-group ${baseConfig.resourceGroup} --name ${baseConfig.cacheStorageAccountName} --location ${baseConfig.region} --kind FileStorage --sku ${baseConfig.cacheStorageSkuName} --output none`,
      { stdio: "inherit" }
    );
    console.log(
      `✅ Cache storage account ${baseConfig.cacheStorageAccountName} created`
    );

    // Azure CLI expects format: YYYY-MM-DDTHH:MM:SSZ (without milliseconds)
    // Get storage account key
    console.log("🔑 Getting storage account key for SAS token...");
    const storageKeyResult = execSync(
      `az storage account keys list --resource-group "${baseConfig.resourceGroup}" --account-name "${baseConfig.storageAccountName}" --query "[0].value" --output tsv`,
      {
        stdio: "pipe",
        encoding: "utf8",
      }
    );
    const cacheStorageKeyResult = execSync(
      `az storage account keys list --resource-group "${baseConfig.resourceGroup}" --account-name "${baseConfig.cacheStorageAccountName}" --query "[0].value" --output tsv`,
      {
        stdio: "pipe",
        encoding: "utf8",
      }
    );

    // Deploy network resources
    await deployNetwork(baseConfig);

    // Get storage account keys
    const storageKey = storageKeyResult.trim();
    const cacheStorageKey = cacheStorageKeyResult.trim();

    return { storageKey, cacheStorageKey };
  } catch (error) {
    console.error("❌ Stack deployment failed:", error.message);
    throw error;
  }
}

export async function deployNetwork(baseConfig: BaseConfig): Promise<void> {
  if (baseConfig.isPrivate) {
    console.log(
      `🔍 Deploying network resources for ${baseConfig.service}-${baseConfig.stage}`
    );

    // Create Private DNS Zone
    execSyncWithoutThrow(
      `az network private-dns zone create --resource-group ${baseConfig.resourceGroup} --name ${baseConfig.dnsZoneName} --output none`,
      { stdio: "inherit" }
    );
    console.log(`✅ Private DNS zone ${baseConfig.dnsZoneName} ensured`);

    // Create NSG
    execSyncWithoutThrow(
      `az network nsg create --resource-group ${baseConfig.resourceGroup} --name ${baseConfig.networkSecurityGroup} --location ${baseConfig.region} --output none`,
      { stdio: "inherit" }
    );
    console.log(`✅ NSG ${baseConfig.networkSecurityGroup} ensured`);

    // Create NSG Rule
    if (baseConfig.allowedSourceAddressPrefixes.length) {
      execSyncWithoutThrow(
        `az network nsg rule create --resource-group ${baseConfig.resourceGroup} --nsg-name ${baseConfig.networkSecurityGroup} --name ${baseConfig.nsgRuleName} --priority 100 --direction Inbound --access Allow --protocol Tcp --source-address-prefixes ${baseConfig.allowedSourceAddressPrefixes} --destination-port-ranges 443 --output none`,
        { stdio: "inherit" }
      );
      console.log(`✅ NSG rule ${baseConfig.nsgRuleName} ensured`);
    }

    execSyncWithoutThrow(
      `az network vnet create --resource-group ${baseConfig.resourceGroup} --name ${baseConfig.vnetName} --location ${baseConfig.region} --address-prefix 10.0.0.0/16 --output none`,
      { stdio: "inherit" }
    );
    console.log(`✅ VNet ${baseConfig.vnetName} ensured`);

    execSyncWithoutThrow(
      `az network private-dns link vnet create --resource-group ${baseConfig.resourceGroup} --zone-name ${baseConfig.dnsZoneName} --name ${baseConfig.vnetName}-link --virtual-network ${baseConfig.vnetName} --registration-enabled false --output none`,
      { stdio: "inherit" }
    );
    console.log(`✅ DNS zone linked to VNet`);
  }
}

export async function deployHandlers(
  functionAppConfigs: FunctionAppConfig[],
  bicepFilePath: string,
  deploymentName: string,
  baseConfig: BaseConfig,
  storageKey: string,
  cacheStorageKey: string
): Promise<void> {
  try {
    console.log(`🔍 Validating Bicep template: ${bicepFilePath}`);

    // First, validate the Bicep template
    execSync(`az bicep build --file "${bicepFilePath}"`, {
      stdio: "pipe",
      encoding: "utf8",
    });

    console.log("✅ Bicep template validation successful");

    console.log("📦 Uploading deployment package...");
    const uploadedBlobName = await uploadDeploymentPackages(
      baseConfig,
      baseConfig.containerName,
      functionAppConfigs[0].runtimeStack
    );

    console.log("🔑 Generating SAS token for package...");
    const blobName = uploadedBlobName;
    const sasExpiryTime =
      new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours from now
        .toISOString()
        .split(".")[0] + "Z"; // Remove milliseconds and add Z

    const sasTokenResult = execSync(
      `az storage blob generate-sas --account-name "${baseConfig.storageAccountName}" --container-name "${baseConfig.containerName}" --name "${blobName}" --permissions r --expiry "${sasExpiryTime}" --account-key "${storageKey}" --output tsv`,
      {
        stdio: "pipe",
        encoding: "utf8",
      }
    );
    const sasToken = sasTokenResult.trim();

    // Construct package URI with SAS token
    const packageUri = `https://${baseConfig.storageAccountName}.blob.core.windows.net/${baseConfig.containerName}/${blobName}?${sasToken}`;
    console.log(`📦 Package URI with SAS token generated (expires in 24h)`);

    console.log(`🚀 Deploying complete infrastructure with ZipDeploy...`);
    const deploymentResult = execSync(
      `az deployment group create --resource-group "${baseConfig.resourceGroup}" --template-file "${bicepFilePath}" --name "${deploymentName}" --parameters location="${baseConfig.region}" packageUri="${packageUri}" deploymentStorageKey="${storageKey}" --output json`,
      {
        encoding: "utf8",
      }
    );
    const deployment = JSON.parse(deploymentResult);
    const functionAppName = deployment.properties.outputs.functionAppName.value;

    console.log(
      `🔑 Adding storage account ${baseConfig.cacheStorageAccountName} to function app ${functionAppName}`
    );
    const shareName = `${baseConfig.service}-${baseConfig.stage}-${functionAppConfigs[0].runtimeStack}`;

    execSyncWithoutThrow(
      `az storage share-rm create --resource-group ${baseConfig.resourceGroup} --storage-account ${baseConfig.cacheStorageAccountName} --name ${shareName} --quota ${functionAppConfigs[0].cache.size} --enabled-protocols SMB --output none`,
      { stdio: "inherit" }
    );
    execSyncWithoutThrow(
      `az webapp config storage-account add --resource-group ${baseConfig.resourceGroup} --name ${functionAppName} --custom-id ${shareName} --storage-type AzureFiles --share-name ${shareName} --account-name ${baseConfig.cacheStorageAccountName} --mount-path ${functionAppConfigs[0].cache.mountPath} --access-key ${cacheStorageKey}`,
      {
        stdio: "inherit",
      }
    );

    console.log("✅ Deployment successful!");
  } catch (error) {
    console.error("❌ Handler deployment failed:", error.message);
    throw error;
  }
}

export async function postDeploymentOutputs(
  deploymentNames: string[],
  baseConfig: BaseConfig
): Promise<{ outputs: any }> {
  for (const deploymentName of deploymentNames) {
    try {
      console.log("📋 Getting deployment outputs...");
      const outputsResult = execSync(
        `az deployment group show --resource-group "${baseConfig.resourceGroup}" --name "${deploymentName}" --query "properties.outputs" --output json`,
        {
          stdio: "pipe",
          encoding: "utf8",
        }
      );

      const outputs = JSON.parse(outputsResult.trim());
      console.log("📊 Deployment outputs:", JSON.stringify(outputs, null, 2));

      return { outputs };
    } catch (error) {
      console.error("❌ Failed to get deployment outputs:", error.message);
      throw error;
    }
  }
}
