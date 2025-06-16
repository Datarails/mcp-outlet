import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import path from "path";
import {
  ApiConfig,
  BaseConfig,
  FunctionAppConfig,
  validateConfig,
  generateBicepTemplate,
  BicepDeploymentConfig,
  deployStack,
  deployHandlers,
  postDeploymentOutputs,
} from "./helpers.ts";
import {
  isAzureConfig,
  MultiCloudConfig,
  MultiCloudConfigSchema,
  MultiCloudDeployer,
  resolveSourcePath,
  downloadLayer,
  Layer,
  createUniqueHash,
} from "../shared.ts";
import { ESBuildServerless, FunctionConfig } from "../package/esbuild.ts";

import { zipDirectoryAsIs, zipSinglePackage } from "../package/compress.ts";

// Azure-specific defaults
const AZURE_DEFAULTS = {
  cacheStorageSkuName: "Premium_LRS",
  functionApp: {
    osType: "Linux",
    runtimeStack: "node",
    runtimeVersion: "20",
    logLevel: "Information",
    skuName: "EP1", // Elastic Premium plan aligns with working manual Bicep
    skuTier: "ElasticPremium", // Elastic Premium tier provides better performance and cold-start profile
  },
  api: {
    corsOptions: {
      allowCredentials: false,
      allowedOrigins: ["*"],
      allowedMethods: ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    },
  },
};

const RUNTIME_INDEX_MAPPING = {
  node: 0,
  python: 1,
};
// Runtime mapping from generic to Azure
const RUNTIME_MAPPING: Record<string, { stack: string; version: string }> = {
  node18: { stack: "node", version: "18" },
  node20: { stack: "node", version: "20" },
  "python3.9": { stack: "python", version: "3.9" },
  "python3.10": { stack: "python", version: "3.10" },
  "python3.11": { stack: "python", version: "3.11" },
  "python3.12": { stack: "python", version: "3.12" },
  dotnet6: { stack: "dotnet-isolated", version: "6" },
  dotnet8: { stack: "dotnet-isolated", version: "8" },
  java11: { stack: "java", version: "11" },
  java17: { stack: "java", version: "17" },
  powershell7: { stack: "powershell", version: "7.4" },
};
const DOCKER_IMAGE_MAP = {
  "3.9": "python:3.9-slim",
  "3.10": "python:3.10-slim",
  "3.11": "python:3.11-slim",
  "3.12": "python:3.12-slim",
};
const SKU_FAMILY_MAP = {
  Free: "F",
  Shared: "D",
  Basic: "B",
  Standard: "S",
  PremiumV2: "P",
  PremiumV3: "P",
  PremiumV4: "P",
  IsolatedV2: "I",
  Dynamic: "Y",
  ElasticPremium: "EP",
  WorkflowStandard: "WS",
};

export class AzureConfigNormalizer {
  private config: MultiCloudConfig;

  constructor(config: unknown) {
    // Validate the config against the schema
    const validatedConfig = MultiCloudConfigSchema.parse(config);

    if (!isAzureConfig(validatedConfig)) {
      throw new Error(
        `Config is not for Azure provider. Got: ${validatedConfig.cloud.provider}`
      );
    }

    this.config = validatedConfig;
  }

  // Normalize generic config to Azure BaseConfig
  normalizeBaseConfig(): BaseConfig {
    const baseName = `${this.config.service}${this.config.stage}`
      .replace(/-/g, "")
      .toLowerCase()
      .substring(0, 24);
    return {
      ...this.config.cloud,
      vnetName: `${baseName}vnet`,
      resourceGroup: this.config.cloud.resourceGroup as string,
      service: this.config.service,
      stage: this.config.stage,
      version: this.config.version,
      isPrivate: this.config.networkAccess.isPrivate,
      networkSecurityGroup: `${baseName}nsg`,
      dnsZoneName:
        this.config.networkAccess.dnsZoneName ||
        `${baseName}.privatelink.azurewebsites.net`,
      allowedSourceAddressPrefixes:
        (this.config.networkAccess.allowedSourceAddressPrefixes as string[]) ||
        [],
      nsgRuleName: createUniqueHash(
        (
          (this.config.networkAccess
            .allowedSourceAddressPrefixes as string[]) || []
        ).join(",")
      ),
      containerName: baseName,
      cacheStorageSkuName:
        (this.config.cacheStorageSkuName as string) ||
        AZURE_DEFAULTS.cacheStorageSkuName,
      storageAccountName: `${baseName}storage`,
      cacheStorageAccountName: `${baseName}cache`,
    };
  }

  // Normalize Function App configuration
  normalizeFunctionAppConfigs(): FunctionAppConfig[] {
    const skuName = this.config.functions[0].skuName as string;
    const skuTier = this.config.functions[0].skuTier as string;
    return this.config.functions.map((func): FunctionAppConfig => {
      const fullRuntime = `${func.runtime.type}${func.runtime.version}`;
      const runtime = RUNTIME_MAPPING[fullRuntime];
      if (!runtime) {
        throw new Error(`Unsupported runtime: ${fullRuntime}`);
      }

      const functionAppConfig: FunctionAppConfig = {
        ...func,
        runtimeStack: runtime.stack,
        runtimeVersion: runtime.version,
        // this must run on linux for mounting shared cache
        osType: AZURE_DEFAULTS.functionApp.osType,
        skuName: skuName || AZURE_DEFAULTS.functionApp.skuName,
        skuTier: skuTier || AZURE_DEFAULTS.functionApp.skuTier,
        skuFamily: SKU_FAMILY_MAP[skuTier] || "EP",
        logLevel: func.logLevel || AZURE_DEFAULTS.functionApp.logLevel,
        events: this.normalizeEventsConfig(func.name, func.events),
      };

      return functionAppConfig;
    });
  }

  // Normalize events configuration - support both API Management (REST) and HTTP triggers (HTTP)
  normalizeEventsConfig(
    functionName: string,
    events: MultiCloudConfig["functions"][number]["events"]
  ): ApiConfig[] {
    return events.map((event) => {
      if (event.type === "rest") {
        // REST events use API Management (slow deployment but more features)
        return {
          apiName: `${this.config.service}-${this.config.stage}-${functionName}-api`,
          description: event?.description || `REST API for ${functionName}`,
          corsOptions: {
            allowCredentials: false,
            allowedOrigins: event.cors.origins.length
              ? event.cors.origins
              : AZURE_DEFAULTS.api.corsOptions.allowedOrigins,
            allowedMethods: event.cors?.methods?.length
              ? event.cors.methods.map((m) => m.toUpperCase())
              : AZURE_DEFAULTS.api.corsOptions.allowedMethods,
            allowedHeaders:
              event.cors?.headers ||
              AZURE_DEFAULTS.api.corsOptions.allowedHeaders,
          },
          endpoint: {
            path: event.endpoint.path,
            methods: event.endpoint.methods,
          },
          skuName: "Developer",
          publisherName: this.config.service,
          publisherEmail: "noreply@example.com",
        };
      } else if (event.type === "http") {
        // HTTP events use Function App HTTP triggers (fast deployment, basic features)
        return {
          // No apiName indicates this is an HTTP trigger event
          description: event?.description || `HTTP trigger for ${functionName}`,
          corsOptions: {
            allowCredentials: false,
            allowedOrigins: event.cors.origins.length
              ? event.cors.origins
              : AZURE_DEFAULTS.api.corsOptions.allowedOrigins,
            allowedMethods: event.cors?.methods?.length
              ? event.cors.methods.map((m) => m.toUpperCase())
              : AZURE_DEFAULTS.api.corsOptions.allowedMethods,
            allowedHeaders:
              event.cors?.headers ||
              AZURE_DEFAULTS.api.corsOptions.allowedHeaders,
          },
          endpoint: {
            path: event.endpoint.path,
            methods: event.endpoint.methods,
          },
          skuName: "N/A", // Not applicable for HTTP triggers
          publisherName: this.config.service,
          publisherEmail: "noreply@example.com",
        } as ApiConfig;
      } else {
        throw new Error(
          `Event type ${event.type} is not supported. Use 'rest' for API Management or 'http' for HTTP triggers.`
        );
      }
    });
  }
}

export async function deployAzureServerless(
  stackId: string,
  config: MultiCloudConfig
) {
  console.log("🚀 Starting Azure serverless deployment with Bicep...");

  const normalizer = new AzureConfigNormalizer(config);
  const baseConfig = normalizer.normalizeBaseConfig();
  const allFunctionAppConfigs = normalizer.normalizeFunctionAppConfigs();

  // Group functions by runtime
  const functionsByRuntime = allFunctionAppConfigs.reduce((acc, func) => {
    const runtime = func.runtimeStack;
    if (!acc[runtime]) {
      acc[runtime] = [];
    }
    acc[runtime].push(func);
    return acc;
  }, {} as Record<string, FunctionAppConfig[]>);

  const runtimes = Object.keys(functionsByRuntime);
  console.log(`📋 Found ${runtimes.length} runtime(s): ${runtimes.join(", ")}`);

  // Create output directory
  const outputDir = join(process.cwd(), ".mcp-outlet", "azure");
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const deploymentStacks: string[] = [];
  const stackData = await deployStack(baseConfig, {});

  // Deploy each runtime separately
  for (const runtime of runtimes) {
    const runtimeFunctions = functionsByRuntime[runtime];
    const runtimeStackId = `${stackId}-${runtime}`;

    console.log(`📋 Generating Bicep template for ${runtime} runtime...`);

    const azureConfig: BicepDeploymentConfig = {
      functionApps: runtimeFunctions,
      additionalTags: {},
    };

    // Generate Bicep template for this runtime
    const bicepTemplate = generateBicepTemplate({
      base: baseConfig,
      config: azureConfig,
      subnetIndex: RUNTIME_INDEX_MAPPING[runtime],
    });

    // Write Bicep template to file
    const bicepFilePath = join(outputDir, `${runtimeStackId}.bicep`);
    writeFileSync(bicepFilePath, bicepTemplate);

    console.log(
      `📝 Bicep template for ${runtime} written to: ${bicepFilePath}`
    );

    console.log(
      `☁️ Deploying ${runtime} functions to Azure using Azure CLI...`
    );
    await deployHandlers(
      runtimeFunctions,
      bicepFilePath,
      runtimeStackId,
      baseConfig,
      stackData.storageKey,
      stackData.cacheStorageKey
    );
    deploymentStacks.push(runtimeStackId);

    console.log(`✅ ${runtime} deployment completed successfully!`);
  }

  await postDeploymentOutputs(deploymentStacks, baseConfig);
  console.log("✅ All Azure deployments completed successfully!");

  return {
    deployments: deploymentStacks,
    totalRuntimes: runtimes.length,
  };
}

export class AzureServerlessDeployer extends MultiCloudDeployer {
  async deploy(stackId: string): Promise<void> {
    const result = await deployAzureServerless(stackId, this.config);
    console.log(
      `🎯 Successfully deployed ${result.totalRuntimes} runtime(s) to Azure`
    );

    // Log deployment details
    result.deployments.forEach((deployment) => {
      console.log(`  └─ ${deployment}`);
    });
  }

  validate(): void {
    validateConfig(this.config);
  }

  async package(): Promise<void> {
    console.log("📦 Packaging Azure Functions...");
    const esBuildFunctions = this.config.functions.filter(
      (func) => func.runtime.type === "node"
    );
    const pythonFunctions = this.config.functions.filter(
      (func) => func.runtime.type === "python"
    );

    if (
      pythonFunctions.length + esBuildFunctions.length !==
      this.config.functions.length
    ) {
      throw new Error("Only node and python functions are supported for Azure");
    }

    // Package Node.js functions with ESBuild
    if (esBuildFunctions.length > 0) {
      const esbuild = new ESBuildServerless(this.config.package);
      const config: FunctionConfig[] = esBuildFunctions.flatMap((func) => {
        const eventTypes = [...new Set(func.events.map((event) => event.type))];
        if (
          eventTypes.some((eventType) => !["rest", "http"].includes(eventType))
        ) {
          throw new Error("ESBuild is not supported for non-rest/http events");
        }

        // Use helper function for proper path resolution with validation
        const sourcePath = resolveSourcePath(func.source, func.name);
        const wrapperSourcePath = resolveSourcePath(
          "deployments/azure/handlerWrappers.ts",
          func.name
        );

        return {
          source: sourcePath,
          name: func.handler,
          exportName: func.name + this.config.apiSuffix,
          target: "js/" + func.name + this.config.apiSuffix + ".js",
          wrapper: {
            path: wrapperSourcePath, // Path to your wrapper file
            export: "handlerAzureFunctionWrapper", // Export name from the wrapper
            layers: (func.layers as Layer[]) || [], // Optional layers
          },
        };
      });

      await esbuild.build(config);
    }

    // Build Python functions using uv

    if (pythonFunctions.length > 0) {
      console.log("🔨 Building Python functions with uv...");

      const pythonDir = path.join(process.cwd(), "src/python");
      const buildOutputDir = path.join(
        process.cwd(),
        this.config.package.outputDir + "/python"
      );

      // Ensure output directory exists
      mkdirSync(buildOutputDir, { recursive: true });

      console.log("📦 Installing dependencies with uv...");

      // First, sync dependencies to ensure they're available
      const syncProcess = spawn("uv", ["sync"], {
        cwd: pythonDir,
        stdio: "inherit",
      });

      await new Promise<void>((resolve, reject) => {
        syncProcess.on("close", (code) => {
          if (code === 0) {
            console.log("✅ Dependencies synced successfully");
            resolve();
          } else {
            reject(new Error(`Dependency sync failed with exit code ${code}`));
          }
        });
        syncProcess.on("error", reject);
      });

      // Install package and all dependencies from pyproject.toml in one step
      console.log(
        "📦 Building Python package for Azure Functions (Linux x86_64)..."
      );
      const dockerImage = DOCKER_IMAGE_MAP[pythonFunctions[0].runtime.version];
      if (!dockerImage) {
        throw new Error(
          `Unsupported Python version: ${pythonFunctions[0].runtime.version}`
        );
      }
      const buildProcess = spawn(
        "docker",
        [
          "run",
          "--rm",
          "--platform",
          "linux/amd64", // Explicitly target Linux x86_64
          "-v",
          `${pythonDir}:/workspace`,
          "-v",
          `${buildOutputDir}:/output`,
          "-w",
          "/workspace",
          dockerImage,
          "sh",
          "-c",
          `
            echo "Installing uv..." && \
            pip install uv && \
            echo "Building package with uv..." && \
            uv pip install . --target /output --system && \
            echo "✅ Build completed for Linux x86_64" && \
            echo "📁 Package contents:" && \
            ls -la /output/ && \
            echo "🔍 Checking pydantic_core binary:" && \
            find /output -name "*pydantic_core*" -type f
          `,
        ],
        {
          stdio: "inherit",
        }
      );

      await new Promise<void>((resolve, reject) => {
        buildProcess.on("close", (code) => {
          if (code === 0) {
            console.log("✅ Linux x86_64 build completed successfully");
            resolve();
          } else {
            reject(new Error(`Docker build failed with exit code ${code}`));
          }
        });
        buildProcess.on("error", (error) => {
          console.error("❌ Docker build error:", error);
          reject(error);
        });
      });

      // Optional: Clean up __pycache__ and other unnecessary files for Azure Functions
      console.log("🧹 Cleaning up build artifacts...");

      const cleanupGlobs = [
        path.join(buildOutputDir, "**/__pycache__"),
        path.join(buildOutputDir, "**/*.pyc"),
        path.join(buildOutputDir, "**/*.pyo"),
        path.join(buildOutputDir, "**/*.pyd"),
        path.join(buildOutputDir, "**/.DS_Store"),
      ];

      for (const glob of cleanupGlobs) {
        try {
          const files = await import("glob").then((m) => m.glob(glob));
          for (const file of files) {
            rmSync(file, { recursive: true, force: true });
          }
        } catch (error) {
          // Ignore cleanup errors
          console.warn(`Warning: Could not clean ${glob}:`, error.message);
        }
      }

      console.log("✅ Python functions built and ready for Azure Functions");
    }

    // Create separate Azure Function App packages for each runtime
    if (esBuildFunctions.length > 0) {
      await createSingleAzureFunctionPackage(
        esBuildFunctions,
        this.config.package.outputDir + "/js",
        this.config.package.outputDir,
        this.config.apiSuffix,
        "node",
        `${this.config.service}-${this.config.stage}-node`
      );
    }

    if (pythonFunctions.length > 0) {
      await createSingleAzureFunctionPackage(
        pythonFunctions,
        this.config.package.outputDir + "/python",
        this.config.package.outputDir,
        this.config.apiSuffix,
        "python",
        `${this.config.service}-${this.config.stage}-python`,
        false
      );
    }

    console.log("✅ Azure Functions packaged successfully!");
  }
}

// Create single Azure Function App package matching working template
async function createSingleAzureFunctionPackage(
  functions: MultiCloudConfig["functions"],
  src: string,
  outDir: string,
  apiSuffix: string,
  runtime: string,
  packageName: string,
  single: boolean = true
): Promise<void> {
  console.log(`📦 Creating single deployment package: ${packageName}.zip`);
  // Prepare layer file paths
  const layerPaths: string[] = [];

  // Prepare additional content files for the package
  const additionalContent: Array<{ content: string; name: string }> = [];

  // Add host.json at root level
  const hostJson = {
    version: "2.0",
    functionTimeout: "00:05:00",
    extensionBundle: {
      id: "Microsoft.Azure.Functions.ExtensionBundle",
      version: "[4.*, 5.0.0)",
    },
    logging: {
      fileLoggingMode: "always",
      logLevel: {
        default: "Information",
        "Host.Results": "Information",
        Function: "Information",
        "Host.Aggregator": "Information",
      },
      console: {
        isEnabled: true,
      },
    },
  };
  additionalContent.push({
    content: JSON.stringify(hostJson, null, 2),
    name: "host.json",
  });

  // Add function-specific files for HTTP events
  for (const func of functions) {
    // TODO - prevent duplicate layers and use same for multiple functions
    for (const layer of func.layers) {
      const layerPath = await downloadLayer("layers", layer);
      layerPaths.push(layerPath);
    }

    const functionName = func.name + apiSuffix;
    const httpEvents = func.events.filter((event) => event.type === "http");

    if (httpEvents.length > 0) {
      const event = httpEvents[0]; // Use first HTTP event for configuration

      // Add function.json in function subfolder
      const functionJson = {
        scriptFile: runtime === "node" ? "index.js" : "index.py",
        bindings: [
          {
            authLevel: "anonymous",
            type: "httpTrigger",
            direction: "in",
            name: "req",
            methods: event.endpoint.methods.map((m) => m.toLowerCase()),
            route: event.endpoint.path.startsWith("/")
              ? event.endpoint.path.substring(1)
              : event.endpoint.path, // Remove leading slash for Azure Functions route
          },
          {
            type: "http",
            direction: "out",
            name: "res",
          },
        ],
      };
      additionalContent.push({
        content: JSON.stringify(functionJson, null, 2),
        name: `${func.name}/function.json`,
      });

      if (runtime === "node") {
        // Add index.js in function subfolder for Node.js functions
        // Create a valid JavaScript variable name from the function name
        const exportVarName = functionName.replace(/[^a-zA-Z0-9_$]/g, "_");
        // Import ES module using dynamic import and convert to CommonJS for Azure Functions
        const indexJs = `module.exports = async function (context, req) {
  const { ${exportVarName} } = await import('../${functionName}');
  return await ${exportVarName}(context, req);
};`;
        additionalContent.push({
          content: indexJs,
          name: `${func.name}/index.js`,
        });
      } else if (runtime === "python") {
        // Add index.py in function subfolder for Python functions
        const layers = (func.layers as Layer[]) || [];
        const indexPy = `
import os, sys

# Add built Python package to path (it's in the same directory)
current_dir = os.path.dirname(__file__)
parent_dir = os.path.dirname(current_dir)
sys.path.insert(0, parent_dir)
sys.path.insert(0, current_dir)

from handlerWrappers import handler_azure_function_wrapper
main = handler_azure_function_wrapper("${func.handler}", ${JSON.stringify(
          layers
        )})
`;
        additionalContent.push({
          content: indexPy,
          name: `${func.name}/index.py`,
        });

        // Add handlerWrappers.py to the deployment
        const wrapperPath = "deployments/azure/handlerWrappers.py";
        const wrapperContent = readFileSync(wrapperPath, "utf-8");
        additionalContent.push({
          content: wrapperContent,
          name: `handlerWrappers.py`,
        });
      }
    }
  }

  if (single) {
    await zipSinglePackage(
      functions,
      outDir,
      packageName,
      outDir + "/js",
      apiSuffix,
      layerPaths, // additionalFiles (layers)
      additionalContent // additionalContent (host.json, function.json, index.js)
    );
  } else {
    // Use zipSinglePackage utility
    await zipDirectoryAsIs(
      src,
      outDir,
      packageName,
      layerPaths, // additionalFiles (layers)
      additionalContent // additionalContent (host.json, function.json, index.js)
    );
  }
}
