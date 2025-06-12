import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as logs from "aws-cdk-lib/aws-logs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import {
  ApiConfig,
  BaseConfig,
  createServerlessStack,
  LambdaConfig,
  OutputConfig,
  S3Config,
  validateConfig,
} from "./helpers.ts";
import {
  isAWSConfig,
  MultiCloudConfig,
  MultiCloudConfigSchema,
  MultiCloudDeployer,
  resolveSourcePath,
} from "../shared.ts";
import { ESBuildServerless, FunctionConfig } from "../package/esbuild.ts";
import { handlerLambdaWrapper } from "./handlerWrappers.ts";
import { zipFunctions } from "../package/compress.ts";

// AWS-specific defaults
const AWS_DEFAULTS = {
  lambda: {
    logRetention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    logLevel: "INFO",
  },
  s3: {
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    cors: [
      {
        allowedHeaders: ["*"],
        allowedMethods: [
          s3.HttpMethods.GET,
          s3.HttpMethods.POST,
          s3.HttpMethods.PUT,
        ],
        allowedOrigins: ["*"],
        maxAge: 3000,
      },
    ] as s3.CorsRule[],
  },
  api: {
    corsOptions: {
      allowOrigins: apigateway.Cors.ALL_ORIGINS,
      allowMethods: apigateway.Cors.ALL_METHODS,
      allowHeaders: ["Content-Type", "Authorization"],
    },
    deployOptions: {
      stageName: "prod",
      throttle: {
        rateLimit: 1000,
        burstLimit: 2000,
      },
    },
  },
};

// Runtime mapping from generic to AWS
const RUNTIME_MAPPING: Record<string, lambda.Runtime> = {
  "nodejs18.x": lambda.Runtime.NODEJS_18_X,
  "nodejs20.x": lambda.Runtime.NODEJS_20_X,
  "python3.9": lambda.Runtime.PYTHON_3_9,
  "python3.10": lambda.Runtime.PYTHON_3_10,
  "python3.11": lambda.Runtime.PYTHON_3_11,
  java11: lambda.Runtime.JAVA_11,
  java17: lambda.Runtime.JAVA_17,
  dotnet6: lambda.Runtime.DOTNET_6,
};

export class AWSConfigNormalizer {
  private config: MultiCloudConfig;

  constructor(config: unknown) {
    // Validate the config against the schema
    const validatedConfig = MultiCloudConfigSchema.parse(config);

    if (!isAWSConfig(validatedConfig)) {
      throw new Error(
        `Config is not for AWS provider. Got: ${validatedConfig.provider}`
      );
    }

    this.config = validatedConfig;
  }

  // Normalize generic config to AWS BaseConfig
  normalizeBaseConfig(): BaseConfig {
    return {
      service: this.config.service,
      stage: this.config.stage,
      version: this.config.version,
      region: this.config.cloud.region,
      accountId: this.config.cloud.accountId || "",
      profile: this.config.cloud.credentials?.profile || "default",
    };
  }

  // Normalize lambda configuration
  normalizeLambdaConfigs(): LambdaConfig[] {
    return this.config.functions.map((func): LambdaConfig => {
      const fullRuntime = `${func.runtime.type}${func.runtime.version}`;
      const runtime = RUNTIME_MAPPING[fullRuntime];

      const lambdaConfig: LambdaConfig = {
        functionName: func.name,
        codePath: func.source,
        handler: func.handler,
        runtime,
        memorySize: func.memorySize,
        timeout: cdk.Duration.seconds(func.timeout),
        environment: func.environment,
        reservedConcurrentExecutions: func.concurrency,
        logRetention:
          (func.logRetention as logs.RetentionDays) ||
          AWS_DEFAULTS.lambda.logRetention,
        removalPolicy:
          (func.removalPolicy as cdk.RemovalPolicy) ||
          AWS_DEFAULTS.lambda.removalPolicy,
        logLevel: func.logLevel,
        events: this.normalizeEventsConfig(func.name, func.events),
        permissions: this.normalizePermissions(func.permissions),
      };

      return lambdaConfig;
    });
  }

  // Normalize S3 configuration
  normalizeS3Config(): S3Config | undefined {
    if (!this.config.storage || this.config.storage.type !== "object-storage") {
      return undefined;
    }

    const storage = this.config.storage;
    const storageConfig = storage.config || {};

    return {
      bucketName: storage.name,
      versioned: storageConfig.versioning,
      cors: (storageConfig.cors as s3.CorsRule[]) || AWS_DEFAULTS.s3.cors,
      lifecycleRules: this.normalizeLifecycleRules(
        storageConfig.lifecycle?.rules
      ),
      publicReadAccess: storageConfig.publicAccess,
      removalPolicy:
        (storageConfig.removalPolicy as cdk.RemovalPolicy) ||
        AWS_DEFAULTS.s3.removalPolicy,
      blockPublicAccess: storageConfig.publicAccess
        ? s3.BlockPublicAccess.BLOCK_ACLS_ONLY
        : s3.BlockPublicAccess.BLOCK_ALL,
    };
  }

  // Normalize API Gateway configuration
  normalizeEventsConfig(
    functionName: string,
    events: MultiCloudConfig["functions"][number]["events"]
  ): ApiConfig[] {
    return events.map((event) => {
      // Find API events from function events
      if (event.type !== "rest" && event.type !== "http") {
        throw new Error(
          `API Gateway event type ${event.type} is not supported. Only rest and http are supported.`
        );
      }
      // Get CORS configuration from first API event or use defaults
      return {
        apiName: `${this.config.service}-${this.config.stage}-${functionName}-api`,
        description: event?.description || `API for ${functionName}`,
        corsOptions: {
          allowOrigins: event.cors.origins.length
            ? event.cors.origins
            : apigateway.Cors.ALL_ORIGINS,
          allowMethods: event.cors?.methods?.length
            ? event.cors.methods.map((m) => m.toUpperCase())
            : apigateway.Cors.ALL_METHODS,
          allowHeaders: event.cors?.headers,
        },
        endpoint: {
          path: event.endpoint.path,
          methods: event.endpoint.methods,
        },
        deployOptions: {
          stageName: this.config.stage,
        },
      };
    });
  }

  // Normalize outputs configuration
  normalizeOutputConfig(): OutputConfig | undefined {
    const outputs = this.config.deployment?.outputs;
    if (!outputs) return undefined;

    return {
      includeApiUrl: outputs.apiUrl,
      includeFunctionArn: outputs.functionArn,
      includeBucketName: outputs.storageDetails,
      includeBucketArn: outputs.storageDetails,
      customOutputs:
        outputs.custom
          ?.filter((output) => output.name && output.value)
          .map((output) => ({
            name: output.name!,
            value: output.value!,
            description: output.description,
          })) || [],
    };
  }

  // Helper method to normalize lifecycle rules
  private normalizeLifecycleRules(rules: any[]): s3.LifecycleRule[] {
    return rules.map((rule) => ({
      id: rule.id,
      enabled: rule.status === "enabled",
      expiration: rule.expiration
        ? cdk.Duration.days(rule.expiration)
        : undefined,
      transitions:
        rule.transitions?.map((t: any) => ({
          storageClass: this.mapStorageClass(t.storageClass),
          transitionAfter: cdk.Duration.days(t.days),
        })) || [],
    }));
  }

  // Map generic storage classes to AWS storage classes
  private mapStorageClass(storageClass: string): s3.StorageClass {
    const mapping: Record<string, s3.StorageClass> = {
      "standard-ia": s3.StorageClass.INFREQUENT_ACCESS,
      "onezone-ia": s3.StorageClass.ONE_ZONE_INFREQUENT_ACCESS,
      glacier: s3.StorageClass.GLACIER,
      "glacier-ir": s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
      "deep-archive": s3.StorageClass.DEEP_ARCHIVE,
      "intelligent-tiering": s3.StorageClass.INTELLIGENT_TIERING,
    };
    return mapping[storageClass] || s3.StorageClass.INFREQUENT_ACCESS;
  }

  // Get normalized permissions
  private normalizePermissions(
    permissions: MultiCloudConfig["functions"][number]["permissions"]
  ):
    | {
        s3Buckets?: s3.Bucket[];
        customPolicies?: iam.PolicyStatement[];
        includeCloudWatchLogs?: boolean;
        includeCloudWatchMetrics?: boolean;
      }
    | undefined {
    if (!permissions) return undefined;

    return {
      includeCloudWatchLogs: permissions.logging !== false,
      includeCloudWatchMetrics: permissions.monitoring !== false,
      // Note: s3Buckets will be added dynamically in createServerlessStack if S3 is configured
      // customPolicies are converted from the config format
      customPolicies: permissions.customPolicies?.map(
        (policy) =>
          new iam.PolicyStatement({
            actions: policy.actions,
            resources: policy.resources,
          })
      ),
    };
  }

  // Get additional tags
  getAdditionalTags(): Record<string, string> | undefined {
    return this.config.deployment?.tags;
  }
}
export async function deployAWSServerless(
  stackId: string,
  config: MultiCloudConfig
) {
  const normalizer = new AWSConfigNormalizer(config);

  // Create CDK App and scope
  const app = new cdk.App();

  const baseConfig = normalizer.normalizeBaseConfig();
  const lambdaConfigs = normalizer.normalizeLambdaConfigs();
  const s3Config = normalizer.normalizeS3Config();
  const outputConfig = normalizer.normalizeOutputConfig();
  const additionalTags = normalizer.getAdditionalTags();

  // Create the stack (synchronous)
  const stack = createServerlessStack(app, stackId, {
    base: baseConfig,
    config: {
      s3: s3Config,
      lambdas: lambdaConfigs,
      outputs: outputConfig,
      additionalTags,
    },
  });

  // Now actually deploy to AWS (asynchronous)
  console.log(`🚀 Deploying stack ${stackId} to AWS...`);

  try {
    // Synthesize the CDK app to CloudFormation
    const assembly = app.synth();

    // Deploy using AWS CDK programmatically
    const result = await deployStackToAWS(assembly, stackId, baseConfig);

    console.log("✅ Deployment completed successfully!");
    return {
      ...stack,
      deploymentResult: result,
      deploymentStatus: "completed",
    };
  } catch (error) {
    console.error("❌ Deployment failed:", error);
    throw error;
  }
}

async function deployStackToAWS(
  assembly: any,
  stackId: string,
  config: BaseConfig
) {
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);

  try {
    const deployCommand = `cdk deploy ${stackId} --require-approval never --profile ${config.profile}`;
    const { stdout, stderr } = await execAsync(deployCommand, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AWS_REGION: config.region,
        AWS_ACCOUNT_ID: config.accountId,
      },
    });

    console.log("CDK Deploy Output:", stdout);
    if (stderr) console.warn("CDK Deploy Warnings:", stderr);

    return { stdout, stderr };
  } catch (error) {
    throw new Error(`CDK deployment failed: ${error.message}`);
  }
}

export class AWSServerlessDeployer extends MultiCloudDeployer {
  async deploy(stackId: string): Promise<void> {
    this.config.functions.forEach((func) => {
      func.environment = {
        ...func.environment,
        PROVIDER: this.config.provider,
        TEMP_FOLDER: this.config.tempFolder,
        CACHE_DIR: func.cache.mountPath,
      };
    });
    await deployAWSServerless(stackId, this.config);
  }

  validate(): void {
    return validateConfig(this.config);
  }

  async package(): Promise<void> {
    const esBuildFunctions = this.config.functions.filter(
      (func) => func.runtime.type === "node"
    );
    if (esBuildFunctions.length !== this.config.functions.length) {
      throw new Error("ESBuild is not supported for non-node functions");
    }

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
        "deployments/aws/handlerWrappers.ts",
        func.name
      );

      return {
        source: sourcePath,
        name: func.handler,
        target: func.name + this.config.apiSuffix,
        wrapper: {
          path: wrapperSourcePath, // Path to your wrapper file
          export: "handlerLambdaWrapper", // Export name from the wrapper
        },
      };
    });

    // Build the functions
    await esbuild.build(config);

    // Zip the built functions and clean up build directories
    await zipFunctions(
      esBuildFunctions,
      this.config.package.outputDir,
      this.config.apiSuffix,
      true // Remove build directories after zipping
    );
  }
}
