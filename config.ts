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
      runtime: {
        type: "node",
        version: "20",
      },
      name: "mcpOutletJS",
      handler: "rpc",
      source: "src/js/handlers/rpc.ts",
      memorySize: 512,
      timeout: 29,
      concurrency: 50,
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
      name: "mcpOutletPython",
      handler: "rpc",
      source: "src/python/app/handlers/rpc.py",
      concurrency: 50,
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

  // Deployment configuration
  deployment: {
    tags: {
      Service: "mcp-outlet",
      Stage: "dev",
      Environment: "development",
    },
  },
};

export default CONFIGURATION;
