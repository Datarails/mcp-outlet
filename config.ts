import {
  Layer,
  MultiCloudConfig,
  getEnvArray,
  getEnvBoolean,
  getEnvNumber,
  SupportedProvider,
} from "./deployments/shared.ts";
import { config } from "dotenv";
config(); // Load .env file

const uvLayer: Layer = {
  name: "uv.tgz",
  type: "tar",
  uri: "https://github.com/astral-sh/uv/releases/download/0.7.9/uv-x86_64-unknown-linux-gnu.tar.gz",
};
const CONFIGURATION: MultiCloudConfig = {
  // Base configuration
  service: "mcp-outlet",
  stage: process.env.STAGE,
  version: "v1",
  deploymentType: "serverless",

  // this is used for the azure functions app cache storage sku
  cacheStorageSkuName: process.env.CACHE_STORAGE_SKU_NAME,

  // Cloud provider specific config
  cloud: {
    provider: process.env.CLOUD_PROVIDER as SupportedProvider,
    region: process.env.REGION,
    accountId: process.env.ACCOUNT_ID,
    resourceGroup: process.env.RESOURCE_GROUP,
    storageAccountName: process.env.STORAGE_ACCOUNT_NAME,
    cacheStorageAccountName: process.env.CACHE_STORAGE_ACCOUNT_NAME,
  },
  networkAccess: {
    isPrivate: getEnvBoolean(process.env.IS_PRIVATE),
    networkSecurityGroup: process.env.NETWORK_SECURITY_GROUP,
    dnsZoneName: process.env.DNS_ZONE_NAME,
    allowedSourceAddressPrefixes: getEnvArray(
      process.env.ALLOWED_SOURCE_ADDRESS_PREFIXES
    ),
  },
  // this is handled only in remote for running local u kneed to install uv locally and add to path
  package: {
    patterns: [
      "serverless/**/*.js",
      "dist/serverless/**/*.js",
      "serverless/graphql/schema.graphql",
      "!node_modules/**",
      "!serverless/**/*.ts",
    ],
    individually: true,
    esbuild: {
      external: [
        "aws-sdk",
        "util",
        "stream",
        "crypto",
        "fs",
        "path",
        "os",
        "http",
        "https",
        "url",
        "querystring",
        "zlib",
      ],
      bundle: true,
      minify: false,
      format: "esm",
      platform: "node",
      target: "node20",
      mainFields: ["module", "main"],
      conditions: ["import", "module", "default"],
      banner: {
        js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    },
  },

  offline: {
    port: 3001,
  },
  // Function configuration (includes runtime, events, permissions)
  functions: [
    {
      name: "mcpOutletJS",
      handler: "rpc",
      source: "src/js/handlers/rpc.ts",
      runtime: {
        type: "node",
        version: "20",
      },
      // this is used for the azure functions app sku

      // this is used for the azure functions app sku
      skuName: process.env.NODE_SKU_NAME,
      skuTier: process.env.NODE_SKU_TIER,
      maximumElasticWorkerCount: getEnvNumber(
        process.env.NODE_MAXIMUM_ELASTIC_WORKER_COUNT
      ),
      // this is used for aws lambda
      memorySize: getEnvNumber(process.env.NODE_MEMORY_SIZE),
      timeout: getEnvNumber(process.env.NODE_TIMEOUT),

      // this is used for package data there is optional with default value
      cache: {
        size: getEnvNumber(process.env.NODE_CACHE_SIZE),
        mountPath: process.env.NODE_CACHE_MOUNT_PATH,
      },
      scaleLimit: getEnvNumber(process.env.NODE_SCALE_LIMIT),

      events: [
        {
          type: "http",
          description: "MCP Outlet HTTP API",
          cors: {
            enabled: true,
            origins: ["*"],
            methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
            headers: ["Content-Type", "Authorization", "X-API-Key"],
          },
          endpoint: {
            path: "/mcpOutletJS",
            methods: ["POST"],
          },
        },
      ],
    },
    {
      runtime: {
        type: "python",
        version: "3.11",
      },
      // this is used for package data there is optional with default value
      cache: {
        size: getEnvNumber(process.env.PYTHON_CACHE_SIZE),
        mountPath: process.env.PYTHON_CACHE_MOUNT_PATH,
      },

      // this is used for the azure functions app sku
      skuName: process.env.PYTHON_SKU_NAME,
      skuTier: process.env.PYTHON_SKU_TIER,
      maximumElasticWorkerCount: getEnvNumber(
        process.env.PYTHON_MAXIMUM_ELASTIC_WORKER_COUNT
      ),

      // this is used for aws lambda
      memorySize: getEnvNumber(process.env.PYTHON_MEMORY_SIZE),
      timeout: getEnvNumber(process.env.PYTHON_TIMEOUT),

      name: "mcpOutletPython",
      handler: "rpc",
      source: "src/python/app/handlers/rpc.py",
      layers: [uvLayer],
      scaleLimit: getEnvNumber(process.env.PYTHON_SCALE_LIMIT),
      events: [
        {
          type: "http",
          description: "MCP Outlet HTTP API",
          cors: {
            enabled: true,
            origins: ["*"],
            methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
            headers: ["Content-Type", "Authorization", "X-API-Key"],
          },
          endpoint: {
            path: "/mcpOutletPython",
            methods: ["POST"],
          },
        },
      ],
    },
  ],
};

export default CONFIGURATION;
