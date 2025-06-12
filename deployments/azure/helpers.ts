import { execSync } from "child_process";
import { CloudConfig, FunctionConfig, MultiCloudConfig } from "../shared.ts";
import { existsSync } from "fs";

// Base configuration interface
export interface BaseConfig extends CloudConfig {
  service: string;
  stage: string;
  version: string;
  resourceGroup: string;
  containerName: string;
  storageAccountName: string;
  cacheStorageAccountName: string;
}

// Function App configuration
export interface FunctionAppConfig extends FunctionConfig {
  runtimeStack: string;
  runtimeVersion: string;
  osType: string;
  skuName: string;
  skuTier: string;
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
  const skuNames = new Set(this.config.functions.map((v) => v.skuName));
  const skuTiers = new Set(this.config.functions.map((v) => v.skuTier));
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
}): string {
  const { base, config: azureConfig } = config;

  // Create tags object without duplicates
  const baseTags = {
    ManagedBy: "mcp-outlet",
    Service: base.service,
    Stage: base.stage,
    Environment: "development",
  };

  const allTags = azureConfig.additionalTags
    ? { ...baseTags, ...azureConfig.additionalTags }
    : baseTags;

  // Get the first function app for configuration defaults
  const primaryFunc = azureConfig.functionApps[0];

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
param functionAppPlanSku string = '${primaryFunc.skuName}'

@description('Linux runtime stack in format <runtime>|<version> (Linux only).')
param linuxFxVersion string = '${primaryFunc.runtimeStack.toUpperCase()}|${
    primaryFunc.runtimeVersion
  }'

@description('Common tags for all resources')
param tags object = {
  ${Object.entries(allTags)
    .map(([key, value]) => `${key}: '${value}'`)
    .join("\n  ")}
}

// Variables - following working template patterns
var isReserved = (functionPlanOS == 'Linux')
var storageAccountName = toLower(replace('\${resourceNamePrefix}\${stage}storage', '-', ''))
var appServicePlanName = '\${functionAppName}-plan'
var applicationInsightsName = '\${functionAppName}-ai'

// Shared App Service Plan (Elastic Premium)
resource appServicePlan 'Microsoft.Web/serverfarms@2023-01-01' = {
  name: appServicePlanName
  location: location
  tags: tags
  sku: {
    name: functionAppPlanSku
    tier: 'ElasticPremium'
    family: 'EP'
  }
  kind: 'elastic'
  properties: {
    reserved: isReserved
    maximumElasticWorkerCount: 20
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
    siteConfig: {
      minTlsVersion: '1.2'
      linuxFxVersion: isReserved ? linuxFxVersion : null
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
      functionAppScaleLimit: 2
      cors: {
        allowedOrigins: ['*']
        supportCredentials: false
      }
    }
  }
}

resource zipDeploy 'Microsoft.Web/sites/extensions@2021-02-01' = {
  name: '\${functionApp.name}/ZipDeploy'
  properties: {
    packageUri: packageUri
  }
  dependsOn: [
    functionApp
  ]
}

// Outputs
output storageAccountName string = storageAccountName
output applicationInsightsName string = applicationInsights.name
output applicationInsightsInstrumentationKey string = applicationInsights.properties.InstrumentationKey
output functionAppName string = functionApp.name
output functionAppUrl string = 'https://\${functionApp.properties.defaultHostName}'
output packageUri string = packageUri
`;

  return bicepTemplate.trim();
}

export async function uploadDeploymentPackages(
  baseConfig: BaseConfig,
  storageAccountName: string,
  containerName: string,
  runtime: string
): Promise<string> {
  console.log(`📦 Uploading ${runtime} deployment package to blob storage...`);

  // Upload the runtime-specific deployment package
  const zipPath = `.mcp-outlet/${baseConfig.service}-${baseConfig.stage}-${runtime}.zip`;
  const blobName = `${baseConfig.service}-${baseConfig.stage}-${runtime}.zip`;

  console.log(`📂 Package path: ${zipPath}`);
  console.log(`📂 Blob name: ${blobName}`);
  console.log(`🗄️ Storage account: ${storageAccountName}`);
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
    `az storage account keys list --resource-group "${baseConfig.resourceGroup}" --account-name "${storageAccountName}" --query "[0].value" --output tsv`,
    {
      stdio: "pipe",
      encoding: "utf8",
    }
  );
  const storageKey = storageKeyResult.trim();

  try {
    // Upload zip to blob storage using account key
    console.log(
      `📤 Uploading ${zipPath} to ${storageAccountName}/${containerName}/${blobName}...`
    );
    execSync(
      `az storage blob upload --account-name "${storageAccountName}" --account-key "${storageKey}" --container-name "${containerName}" --name "${blobName}" --file "${zipPath}" --overwrite`,
      {
        stdio: "inherit",
      }
    );
    console.log(`✅ Uploaded ${blobName} to blob storage successfully`);

    // Verify the upload
    console.log("🔍 Verifying upload...");
    const blobList = execSync(
      `az storage blob list --account-name "${storageAccountName}" --account-key "${storageKey}" --container-name "${containerName}" --query "[?name=='${blobName}'].{name:name,size:properties.contentLength}" --output json`,
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
  storageAccountName: string;
  storageKey: string;
  cacheStorageKey: string;
}> {
  try {
    console.log(`📦 Creating resource group: ${baseConfig.resourceGroup}`);
    execSync(
      `az group create --name "${baseConfig.resourceGroup}" --location "${
        baseConfig.region
      }" --tags ${Object.entries(tags)
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ")}`,
      {
        stdio: "inherit",
      }
    );

    // Calculate storage account name EXACTLY like in Bicep template
    const storageAccountName = `${baseConfig.service}${baseConfig.stage}storage`
      .replace(/-/g, "") // Remove dashes (like replace function in Bicep)
      .toLowerCase()
      .substring(0, 24); // Limit to 24 characters
    console.log(
      `🔑 Creating storage account ${storageAccountName} in resource group ${baseConfig.resourceGroup} in region ${baseConfig.region}`
    );
    try {
      // Create storage account
      execSync(
        `az storage account create --name "${storageAccountName}" --resource-group "${baseConfig.resourceGroup}" --location "${baseConfig.region}" --sku Standard_LRS --kind StorageV2`,
        { stdio: "inherit" }
      );

      // Create container
      execSync(
        `az storage container create --name "${baseConfig.containerName}" --account-name "${storageAccountName}" --auth-mode login`,
        { stdio: "inherit" }
      );

      console.log(
        `✅ Storage ${storageAccountName} account and container ${baseConfig.containerName} created`
      );
    } catch (error) {
      console.log("ℹ️ Storage account might already exist, continuing...");
    }

    // Creating cache storage account
    console.log(
      `🔑 Creating cache storage account ${baseConfig.cacheStorageAccountName} in resource group ${baseConfig.resourceGroup} in region ${baseConfig.region}`
    );
    try {
      // Create cache storage account
      execSync(
        `az storage account create --resource-group ${baseConfig.resourceGroup} --name ${baseConfig.cacheStorageAccountName} --location ${baseConfig.region} --kind FileStorage --sku Premium_LRS --output none`,
        { stdio: "inherit" }
      );
    } catch (error) {
      console.log(
        "ℹ️ Cache storage account might already exist, continuing..."
      );
    }

    // Azure CLI expects format: YYYY-MM-DDTHH:MM:SSZ (without milliseconds)
    // Get storage account key
    console.log("🔑 Getting storage account key for SAS token...");
    const storageKeyResult = execSync(
      `az storage account keys list --resource-group "${baseConfig.resourceGroup}" --account-name "${storageAccountName}" --query "[0].value" --output tsv`,
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

    const storageKey = storageKeyResult.trim();
    const cacheStorageKey = cacheStorageKeyResult.trim();

    return { storageAccountName, storageKey, cacheStorageKey };
  } catch (error) {
    console.error("❌ Stack deployment failed:", error.message);
    throw error;
  }
}

export async function deployHandlers(
  functionAppConfigs: FunctionAppConfig[],
  bicepFilePath: string,
  deploymentName: string,
  baseConfig: BaseConfig,
  storageAccountName: string,
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
      storageAccountName,
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
      `az storage blob generate-sas --account-name "${storageAccountName}" --container-name "${baseConfig.containerName}" --name "${blobName}" --permissions r --expiry "${sasExpiryTime}" --account-key "${storageKey}" --output tsv`,
      {
        stdio: "pipe",
        encoding: "utf8",
      }
    );
    const sasToken = sasTokenResult.trim();

    // Construct package URI with SAS token
    const packageUri = `https://${storageAccountName}.blob.core.windows.net/${baseConfig.containerName}/${blobName}?${sasToken}`;
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

    try {
      // Create cache share
      execSync(
        `az storage share-rm create --resource-group ${baseConfig.resourceGroup} --storage-account ${baseConfig.cacheStorageAccountName} --name ${shareName} --quota ${functionAppConfigs[0].cache.size} --enabled-protocols SMB --output none`,
        { stdio: "inherit" }
      );
    } catch (error) {
      console.log("ℹ️ Cache share might already exist, continuing...");
    }

    try {
      execSync(
        `az webapp config storage-account add --resource-group ${baseConfig.resourceGroup} --name ${functionAppName} --custom-id ${shareName} --storage-type AzureFiles --share-name ${shareName} --account-name ${baseConfig.cacheStorageAccountName} --mount-path ${functionAppConfigs[0].cache.mountPath} --access-key ${cacheStorageKey}`,
        {
          stdio: "inherit",
        }
      );
    } catch (error) {
      console.log("ℹ️ Storage directory might already exist, continuing...");
    }

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
