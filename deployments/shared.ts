import z from "zod";
import path, { join, parse } from "path";
import { pipeline } from "node:stream/promises";

import fs from "fs";
import { x } from "tar";
import { mkdirSync } from "fs";
import { createWriteStream, existsSync, rmSync, statSync } from "node:fs";
import { execSync, ExecSyncOptions } from "node:child_process";

const ApiEventSchema = z.object({
  type: z.enum(["rest", "http"]),
  name: z.string().optional(),
  description: z.string().optional(),
  cors: z
    .object({
      enabled: z.boolean().default(true),
      origins: z.array(z.string()).default([]),
      methods: z.array(z.string()).default(["GET", "POST", "PUT", "DELETE"]),
      headers: z.array(z.string()).default([]),
    })
    .optional(),
  endpoint: z.object({
    path: z.string(),
    methods: z.array(z.string()),
  }),
});

const NetworkAccessSchema = z
  .object({
    isPrivate: z.boolean().default(false),
    networkSecurityGroup: z.string().optional(),
    dnsZoneName: z.string().optional(),
  })
  .passthrough();

const LayerSchema = z.object({
  name: z.string().describe("The name of the layer which should be unique"),
  description: z.string().optional(),
  uri: z.string(),
  type: z.enum(["tar", "zip"]),
});

const RuntimeSchema = z.object({
  type: z.string().describe("e.g., 'node', 'python'"),
  version: z.string().describe("e.g., '20.x', '3.10'"),
});

const FunctionSchema = z
  .object({
    cache: z.object({
      size: z.number().default(1024),
      mountPath: z.string().default("/mnt/cache"),
    }),
    runtime: RuntimeSchema,
    name: z.string(),
    scaleLimit: z.number().optional(),
    handler: z.string(),
    source: z.string(), // Path to source code
    environment: z.record(z.string()).optional(),
    logLevel: z.string().default("INFO"),
    events: z.array(ApiEventSchema).optional(),
    attachedLayers: LayerSchema.array().optional(),
    layers: z.array(LayerSchema).default([]),
  })
  .passthrough();
const SupportedProviderSchema = z.enum(["azure"]);
const CloudSchema = z
  .object({
    region: z.string(),
    provider: SupportedProviderSchema,
  })
  .passthrough();

// Generic multi-cloud schema
export const MultiCloudConfigSchema = z
  .object({
    // Base configuration
    service: z.string(),
    stage: z.string().default("dev"),
    version: z.string(),
    deploymentType: z.enum(["serverless"]),
    tempFolder: z.string().default("/tmp"),
    operatingSystem: z.enum(["linux"]).default("linux"),

    // Cloud provider specific config
    cloud: CloudSchema,

    networkAccess: NetworkAccessSchema,

    offline: z
      .object({
        port: z.number().default(3000),
      })
      .default({
        port: 3000,
      }),
    apiSuffix: z.string().default("Api"),
    // Function configuration
    functions: FunctionSchema.array(),
    package: z
      .object({
        individually: z.boolean().default(true),
        patterns: z.string().array().default([]),
        outputDir: z.string().default(".mcp-outlet"),
        esbuild: z.object({
          external: z.string().array().default([]),
          bundle: z.boolean().default(true),
          minify: z.boolean().default(true),
          format: z.enum(["esm", "cjs"]).default("esm"),
          target: z.string().default("node20"),
          platform: z.enum(["node", "browser"]).default("node"),
          mainFields: z.string().array().default(["module", "main"]),
          conditions: z
            .string()
            .array()
            .default(["import", "module", "default"]),
          banner: z.record(z.string()).optional(),
        }),
      })
      .optional(),
  })
  .passthrough();

export type NetworkAccessConfig = z.infer<typeof NetworkAccessSchema>;
export type SupportedProvider = z.infer<typeof SupportedProviderSchema>;
export type RuntimeConfig = z.infer<typeof RuntimeSchema>;
export type CloudConfig = z.infer<typeof CloudSchema>;
export type FunctionConfig = z.infer<typeof FunctionSchema>;
export type MultiCloudConfig = z.infer<typeof MultiCloudConfigSchema>;
export type Layer = z.infer<typeof LayerSchema>;
// Provider-specific type guards
export const isAWSConfig = (config: MultiCloudConfig): boolean =>
  config.provider === "aws";

export const isAzureConfig = (config: MultiCloudConfig): boolean =>
  config.cloud.provider === "azure";

export const isGCPConfig = (config: MultiCloudConfig): boolean =>
  config.provider === "gcp";

export class MultiCloudDeployer {
  readonly config: MultiCloudConfig;
  constructor(
    config: unknown,
    // this is used for mocking environment
    public deployer?: MultiCloudDeployer
  ) {
    this.config = MultiCloudConfigSchema.parse(config);
  }

  package(): Promise<void> {
    return Promise.resolve();
  }

  deploy(_stackId: string): Promise<void> {
    return Promise.resolve();
  }

  validate(): void {}

  protected generateStackName(): string {
    return `${this.config.service}-${this.config.stage}`;
  }

  setFunctionsEnvironment(): void {
    for (let i = 0; i < this.config.functions.length; i++) {
      if (!this.config.functions[i].environment) {
        this.config.functions[i].environment = {};
      }
      this.config.functions[i].environment["PROVIDER"] =
        this.config.cloud.provider;
      this.config.functions[i].environment["TEMP_FOLDER"] =
        this.config.tempFolder;
      this.config.functions[i].environment["TEMP_FOLDER"] =
        this.config.tempFolder;

      if (this.config.functions[i].memorySize) {
        this.config.functions[i].environment["FUNCTION_MEMORY_SIZE"] =
          this.config.functions[i].memorySize.toString();
      }
      if (this.config.functions[i].timeout) {
        this.config.functions[i].environment["FUNCTION_TIMEOUT"] =
          this.config.functions[i].timeout.toString();
      }
    }
  }

  protected summarizeResources(resources: any): string {
    const summary: string[] = [];

    if (resources.bucket) {
      summary.push(`S3 Bucket: ${resources.bucket.bucketName || "created"}`);
    }

    if (resources.lambdaFunction) {
      summary.push(
        `Lambda: ${resources.lambdaFunction.functionName || "created"}`
      );
    } else if (resources.lambdaFunctions) {
      summary.push(
        `Lambdas: ${Object.keys(resources.lambdaFunctions).length} functions`
      );
    }

    if (resources.api) {
      summary.push(`API: ${resources.api.restApiId || "created"}`);
    }

    return summary.length > 0 ? summary.join(", ") : "Resources created";
  }
}

export function resolveSourcePath(
  sourcePath: string,
  functionName: string
): string {
  let resolvedPath: string;

  if (path.isAbsolute(sourcePath)) {
    // Already absolute path
    resolvedPath = sourcePath;
  } else {
    // Resolve relative to project root
    resolvedPath = path.resolve(process.cwd(), sourcePath);
  }

  // Validate that the source file exists
  try {
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(
        `Source file not found: ${resolvedPath} (original: ${sourcePath})`
      );
    }
  } catch (error) {
    throw new Error(
      `Failed to validate source file for function ${functionName}: ${error.message}`
    );
  }

  console.log(`Resolved source path for ${functionName}: ${resolvedPath}`);
  return resolvedPath;
}

const addToPath = (dir: string) => {
  // Use the correct delimiter for the OS
  console.log(`PATH: ${process.env.PATH}`, process.platform);
  const DELIM = path.delimiter; // ':' on Linux, ';' on Windows
  const current = (process.env.PATH || "").split(DELIM);

  if (!current.includes(dir)) {
    process.env.PATH = [dir, ...current].join(DELIM);
  }
};

export async function addLayerToPath(layer: Layer) {
  const TMP = process.env.TEMP_FOLDER || "/tmp";

  // 1️⃣  Compute where we want to extract (strip the extension for the folder name)
  const layerBase = parse(layer.name).name; // "uv"
  const layerDir = join(TMP, "layers", layerBase); // "/tmp/layers/uv"
  if (!existsSync(layerDir)) {
    rmSync(layerDir, { recursive: true, force: true });
    mkdirSync(layerDir, { recursive: true });

    await x({
      file: join(".", layer.name), // adjust if you moved it
      cwd: layerDir,
      strip: 1,
    });
  }

  console.log(`Adding to PATH: ${layerDir}`);
  addToPath(layerDir);

  return layerDir;
}

export async function downloadLayer(
  basePath: string,
  layer: Layer
): Promise<string> {
  // 1. Wipe (or create) the target folder
  mkdirSync(basePath, { recursive: true });
  console.log(`📂 [downloadLayer] Ensured empty directory: ${basePath}`);

  // 2. Fetch, explicitly allowing redirects
  console.log(`🔍 [downloadLayer] Fetching ${layer.uri} …`);
  const response = await fetch(layer.uri, { redirect: "follow" });
  console.log(
    `🔍 [downloadLayer] HTTP ${response.status} ${response.statusText}`
  );
  if (!response.ok) {
    console.error(
      `❌ [downloadLayer] GitHub responded with ${response.status}`
    );
    throw new Error(
      `Failed to fetch layer: ${response.status} ${response.statusText}`
    );
  }

  // 3. Log content-length header if present
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    console.log(`ℹ️ [downloadLayer] Content-Length: ${contentLength} bytes`);
  } else {
    console.log(`ℹ️ [downloadLayer] No Content-Length header returned`);
  }

  // 4. Stream the response body into a file
  const outPath = join(basePath, layer.name);
  console.log(`📥 [downloadLayer] Writing to: ${outPath}`);
  const fileStream = createWriteStream(outPath, { mode: 0o644 });
  await pipeline(response.body, fileStream);
  console.log(`✅ [downloadLayer] Download completed: ${outPath}`);

  // 5. Double-check the file size on disk
  const stats = statSync(outPath);
  console.log(`ℹ️ [downloadLayer] Final file size: ${stats.size} bytes`);
  if (stats.size === 0) {
    console.error(`❌ [downloadLayer] Zero-length file at ${outPath}`);
    throw new Error(`Downloaded file is empty: ${outPath}`);
  }

  return outPath;
}

export const getEnvNumber = (value?: string) => {
  console.log(`getEnvNumber: ${value}`);
  if (value) {
    return +value;
  }
  return undefined;
};

export const getEnvBoolean = (value?: string) => {
  if (value) {
    return value === "true";
  }
  return undefined;
};

export const getEnvArray = (value?: string) => {
  if (value) {
    return value.split(",");
  }
  return undefined;
};

export const execSyncWithoutThrow = (
  command: string,
  options: ExecSyncOptions
) => {
  try {
    execSync(command, options);
  } catch (error) {
    console.log(`Already exists: ${command}`);
  }
};

export function createUniqueHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36).substring(0, 6);
}
