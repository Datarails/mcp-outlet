import { Layer, MultiCloudConfig } from "./deployments/shared.ts";
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
  stage: "dev",
  version: "v1",
  provider: "azure",
  deploymentType: "serverless",
  // Cloud provider specific config
  cloud: {
    region: process.env.REGION,
    accountId: process.env.ACCOUNT_ID,
    resourceGroup: process.env.RESOURCE_GROUP,
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

      // this is used for aws lambda
      memorySize: process.env.NODE_MEMORY_SIZE,
      timeout: process.env.NODE_TIMEOUT,

      // this is used for package data there is optional with default value
      cache: {
        size: +process.env.NODE_CACHE_SIZE,
        mountPath: process.env.NODE_CACHE_MOUNT_PATH,
      },

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
        size: process.env.PYTHON_CACHE_SIZE
          ? +process.env.PYTHON_CACHE_SIZE
          : undefined,
        mountPath: process.env.PYTHON_CACHE_MOUNT_PATH,
      },

      // this is used for the azure functions app sku
      skuName: process.env.PYTHON_SKU_NAME,
      skuTier: process.env.PYTHON_SKU_TIER,

      // this is used for aws lambda
      memorySize: process.env.PYTHON_MEMORY_SIZE,
      timeout: process.env.PYTHON_TIMEOUT,

      name: "mcpOutletPython",
      handler: "rpc",
      source: "src/python/app/handlers/rpc.py",
      layers: [uvLayer],
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
