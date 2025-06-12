// aws-utils.ts
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { MultiCloudConfig } from "../shared.ts";

export type StackConfig = { id: string; name: string };
// Base configuration interface
export interface BaseConfig {
  service: string;
  stage: string;
  version: string;
  region: string;
  accountId: string;
  profile: string;
}

// S3 configuration
export interface S3Config {
  bucketName: string;
  versioned?: boolean;
  cors: s3.CorsRule[];
  lifecycleRules: s3.LifecycleRule[];
  publicReadAccess: boolean;
  removalPolicy: cdk.RemovalPolicy;
  blockPublicAccess: s3.BlockPublicAccess;
}

// Lambda configuration
export interface LambdaConfig {
  functionName: string;
  codePath: string; // Path to pre-bundled code (zip file or directory)
  handler: string;
  runtime: lambda.Runtime;
  memorySize: number;
  timeout: cdk.Duration;
  environment: Record<string, string>;
  reservedConcurrentExecutions: number;
  logRetention: logs.RetentionDays;
  removalPolicy: cdk.RemovalPolicy;
  logLevel: string;
  events?: ApiConfig[];
  permissions?: {
    s3Buckets?: s3.Bucket[];
    customPolicies?: iam.PolicyStatement[];
    includeCloudWatchLogs?: boolean;
    includeCloudWatchMetrics?: boolean;
  };
}

// API Gateway configuration
export interface ApiConfig {
  apiName: string;
  description: string;
  corsOptions: apigateway.CorsOptions;
  endpoint: ApiEndpoint;
  deployOptions?: Partial<apigateway.StageOptions>;
}

export interface ApiEndpoint {
  path: string;
  methods: string[];
}

// CloudFormation outputs configuration
export interface OutputConfig {
  includeApiUrl?: boolean;
  includeFunctionArn?: boolean;
  includeBucketName?: boolean;
  includeBucketArn?: boolean;
  customOutputs?: Array<{
    name: string;
    value: string;
    description?: string;
  }>;
}

export type AWSConfig = {
  base: BaseConfig;
  config: {
    s3?: S3Config;
    lambdas: LambdaConfig[];
    outputs?: OutputConfig;
    additionalTags?: Record<string, string>;
  };
};

export function createBucket(
  stack: cdk.Stack,
  id: string,
  s3Config: S3Config
): s3.Bucket {
  console.log(`📦 Creating S3 bucket: ${s3Config.bucketName}`);

  return new s3.Bucket(stack, id, {
    bucketName: s3Config.bucketName,
    removalPolicy: s3Config.removalPolicy,
    versioned: s3Config.versioned,
    cors: s3Config.cors,
    lifecycleRules: s3Config.lifecycleRules,
    publicReadAccess: s3Config.publicReadAccess,
    blockPublicAccess: s3Config.blockPublicAccess,
  });
}

export function createLambda(
  stack: cdk.Stack,
  id: string,
  baseConfig: BaseConfig,
  lambdaConfig: LambdaConfig,
  additionalEnvironment?: Record<string, string>
): lambda.Function {
  console.log(`⚡ Creating Lambda function: ${lambdaConfig.functionName}`);

  // Create log group
  const logGroup = new logs.LogGroup(stack, `${id}LogGroup`, {
    logGroupName: `/aws/lambda/${lambdaConfig.functionName}`,
    retention: lambdaConfig.logRetention,
    removalPolicy: lambdaConfig.removalPolicy,
  });

  // Merge environment variables
  const environment = {
    STAGE: baseConfig.stage,
    SERVICE: baseConfig.service,
    VERSION: baseConfig.version,
    AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1",
    LOG_LEVEL: lambdaConfig.logLevel,
    ...lambdaConfig.environment,
    ...additionalEnvironment,
  };

  return new lambda.Function(stack, id, {
    functionName: lambdaConfig.functionName,
    runtime: lambdaConfig.runtime,
    handler: lambdaConfig.handler,
    code: lambda.Code.fromAsset(lambdaConfig.codePath), // Pre-bundled code
    memorySize: lambdaConfig.memorySize,
    timeout: lambdaConfig.timeout,
    environment,
    logGroup,
    reservedConcurrentExecutions: lambdaConfig.reservedConcurrentExecutions,
  });
}

export function createAPI(
  stack: cdk.Stack,
  id: string,
  apiConfig: ApiConfig,
  lambdaFunction: lambda.Function
): apigateway.RestApi {
  console.log(`🌐 Creating API Gateway: ${apiConfig.apiName}`);

  const api = new apigateway.RestApi(stack, id, {
    restApiName: apiConfig.apiName,
    description: apiConfig.description,
    defaultCorsPreflightOptions: apiConfig.corsOptions,
    deployOptions: apiConfig.deployOptions,
    cloudWatchRole: true,
  });

  // Lambda integration
  const lambdaIntegration = new apigateway.LambdaIntegration(lambdaFunction, {
    proxy: true,
    allowTestInvoke: true,
  });

  // Add configured endpoint
  const resource = api.root.addResource(apiConfig.endpoint.path);
  apiConfig.endpoint.methods.forEach((method) => {
    resource.addMethod(method.toUpperCase(), lambdaIntegration);
  });

  return api;
}

export function setupLambdaPermissions(
  lambdaFunction: lambda.Function,
  permissions: {
    s3Buckets?: s3.Bucket[];
    customPolicies?: iam.PolicyStatement[];
    includeCloudWatchLogs?: boolean;
    includeCloudWatchMetrics?: boolean;
  }
): void {
  console.log(`🔐 Setting up IAM permissions`);

  // Grant S3 permissions
  if (permissions.s3Buckets) {
    permissions.s3Buckets.forEach((bucket) => {
      bucket.grantReadWrite(lambdaFunction);
    });
  }

  // CloudWatch Logs permissions
  if (permissions.includeCloudWatchLogs !== false) {
    lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: ["arn:aws:logs:*:*:*"],
      })
    );
  }

  // CloudWatch Metrics permissions
  if (permissions.includeCloudWatchMetrics !== false) {
    lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
      })
    );
  }

  // Custom policies
  if (permissions.customPolicies) {
    permissions.customPolicies.forEach((policy) => {
      lambdaFunction.addToRolePolicy(policy);
    });
  }
}

export function addOutputs(
  stack: cdk.Stack,
  baseConfig: BaseConfig,
  outputConfig: OutputConfig,
  resources: {
    api?: apigateway.RestApi;
    lambdaFunction?: lambda.Function;
    bucket?: s3.Bucket;
  }
): void {
  console.log(`📋 Adding CloudFormation outputs`);

  const exportPrefix = `${stack.stackName}`;

  if (outputConfig.includeApiUrl && resources.api) {
    new cdk.CfnOutput(stack, "ApiUrl", {
      value: resources.api.url,
      description: `${baseConfig.service} API URL`,
      exportName: `${exportPrefix}-ApiUrl`,
    });
  }

  if (outputConfig.includeFunctionArn && resources.lambdaFunction) {
    new cdk.CfnOutput(stack, "FunctionArn", {
      value: resources.lambdaFunction.functionArn,
      description: `${baseConfig.service} Lambda Function ARN`,
      exportName: `${exportPrefix}-FunctionArn`,
    });
  }

  if (outputConfig.includeBucketName && resources.bucket) {
    new cdk.CfnOutput(stack, "BucketName", {
      value: resources.bucket.bucketName,
      description: `${baseConfig.service} S3 Bucket Name`,
      exportName: `${exportPrefix}-BucketName`,
    });
  }

  if (outputConfig.includeBucketArn && resources.bucket) {
    new cdk.CfnOutput(stack, "BucketArn", {
      value: resources.bucket.bucketArn,
      description: `${baseConfig.service} S3 Bucket ARN`,
      exportName: `${exportPrefix}-BucketArn`,
    });
  }

  // Custom outputs
  if (outputConfig.customOutputs) {
    outputConfig.customOutputs.forEach((output, index) => {
      new cdk.CfnOutput(stack, output.name || `CustomOutput${index}`, {
        value: output.value,
        description: output.description,
        exportName: `${exportPrefix}-${output.name || `CustomOutput${index}`}`,
      });
    });
  }
}

export function addTags(
  stack: cdk.Stack,
  baseConfig: BaseConfig,
  additionalTags?: Record<string, string>
): void {
  cdk.Tags.of(stack).add("Service", baseConfig.service);
  cdk.Tags.of(stack).add("Stage", baseConfig.stage);
  cdk.Tags.of(stack).add("Version", baseConfig.version);
  cdk.Tags.of(stack).add("ManagedBy", "CDK-Deployment");

  if (additionalTags) {
    Object.entries(additionalTags).forEach(([key, value]) => {
      cdk.Tags.of(stack).add(key, value);
    });
  }
}

export function createServerlessStack(
  scope: Construct,
  stackId: string,
  config: AWSConfig
) {
  const stack = new cdk.Stack(scope, stackId, {
    stackName: `${config.base.service}-${config.base.stage}`,
    env: {
      region: config.base.region,
      account: config.base.accountId,
    },
  });

  // Create S3 bucket if configured
  const bucket = config.config.s3
    ? createBucket(stack, "Bucket", config.config.s3)
    : undefined;

  const lambdas = config.config.lambdas.map((lambdaConfig, index) => {
    // Create Lambda function
    const lambdaFunction = createLambda(
      stack,
      `Function${index}`,
      config.base,
      lambdaConfig,
      bucket ? { BUCKET_NAME: bucket.bucketName } : undefined
    );

    // Create API Gateway for each event configuration
    const apis =
      lambdaConfig.events?.map((eventConfig, eventIndex) =>
        createAPI(
          stack,
          `Api${index}-${eventIndex}`,
          eventConfig,
          lambdaFunction
        )
      ) || [];

    // Setup permissions
    const permissions = {
      ...lambdaConfig.permissions,
      s3Buckets: bucket
        ? [bucket, ...(lambdaConfig.permissions?.s3Buckets || [])]
        : lambdaConfig.permissions?.s3Buckets,
    };
    setupLambdaPermissions(lambdaFunction, permissions);

    // Add outputs
    if (config.config.outputs) {
      addOutputs(stack, config.base, config.config.outputs, {
        api: apis[0], // Use first API for outputs
        lambdaFunction,
        bucket,
      });
    }

    // Add tags
    addTags(stack, config.base, config.config.additionalTags);

    return {
      bucket,
      lambdaFunction,
      apis,
    };
  });

  return {
    bucket,
    lambdas,
  };
}

export function validateConfig(config: MultiCloudConfig) {
  if (config.operatingSystem === "windows") {
    throw new Error("Windows is not supported for AWS");
  }

  if (config.tempFolder !== "/tmp") {
    throw new Error("Aws lambda supported temp folder only /tmp");
  }

  const noValidTimeoutFunc = config.functions.filter(
    (lambdaConfig) =>
      lambdaConfig.timeout > 29 &&
      lambdaConfig.events &&
      lambdaConfig.events.length > 0 &&
      lambdaConfig.events.some(
        (event) => event.type === "rest" || event.type === "http"
      )
  );
  if (noValidTimeoutFunc.length > 0) {
    throw new Error(
      `API Gateway is not supported for Lambda functions with a timeout greater than 29 seconds. Lambda function ${noValidTimeoutFunc[0].functionName} has a timeout of ${noValidTimeoutFunc[0].timeout} seconds`
    );
  }
}
