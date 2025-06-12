import { loadConfig, MultiCloudConfig, MultiCloudDeployer } from "./shared.ts";
import { AWSServerlessDeployer } from "./aws/serverless.ts";
import { AzureServerlessDeployer } from "./azure/serverless.ts";
import { LocalDevServer } from "./offline.ts";

export class DeployerFactory extends MultiCloudDeployer {
  private static deployerRegistry: Map<
    string,
    Map<string, new (config: MultiCloudConfig) => MultiCloudDeployer>
  > = new Map();
  private delegate: MultiCloudDeployer;

  // Register deployers for each provider and deployment type
  static {
    // AWS deployers
    const awsDeployers = new Map();
    awsDeployers.set("serverless", AWSServerlessDeployer);

    DeployerFactory.deployerRegistry.set("aws", awsDeployers);

    // Azure deployers
    const azureDeployers = new Map();
    azureDeployers.set("serverless", AzureServerlessDeployer);
    DeployerFactory.deployerRegistry.set("azure", azureDeployers);
  }

  constructor(config: MultiCloudConfig) {
    super(config);
    this.delegate = this.createDelegate();
  }

  setFunctionsEnvironment(): void {
    this.delegate.setFunctionsEnvironment();
  }

  private createDelegate(): MultiCloudDeployer {
    const { provider, deploymentType } = this.config;

    if (!DeployerFactory.deployerRegistry.has(provider)) {
      throw new Error(
        `❌ Unsupported provider: ${provider}. ` +
          `Supported providers: ${Array.from(
            DeployerFactory.deployerRegistry.keys()
          ).join(", ")}`
      );
    }

    const providerDeployers = DeployerFactory.deployerRegistry.get(provider)!;

    if (!providerDeployers.has(deploymentType)) {
      throw new Error(
        `❌ Unsupported deployment type: ${deploymentType} for provider: ${provider}. ` +
          `Supported types for ${provider}: ${Array.from(
            providerDeployers.keys()
          ).join(", ")}`
      );
    }

    const DeployerClass = providerDeployers.get(deploymentType)!;

    return new DeployerClass(this.config);
  }

  // Implement MultiCloudDeployer interface by delegating to provider-specific deployer
  async deploy(stackId: string): Promise<void> {
    await this.delegate.deploy(stackId);
  }

  validate(): void {
    this.delegate.validate();
  }

  async package(): Promise<void> {
    await this.delegate.package();
  }

  // Static utility methods for introspection
  static getSupportedProviders(): string[] {
    return Array.from(this.deployerRegistry.keys());
  }

  static getSupportedDeploymentTypes(provider: string): string[] {
    const providerDeployers = this.deployerRegistry.get(provider);
    return providerDeployers ? Array.from(providerDeployers.keys()) : [];
  }

  static getAllSupportedCombinations(): Array<{
    provider: string;
    deploymentType: string;
  }> {
    const combinations: Array<{ provider: string; deploymentType: string }> =
      [];

    for (const [provider, deploymentTypes] of this.deployerRegistry.entries()) {
      for (const deploymentType of deploymentTypes.keys()) {
        combinations.push({ provider, deploymentType });
      }
    }

    return combinations;
  }

  // Register new deployer at runtime (for plugins/extensions)
  static registerDeployer(
    provider: string,
    deploymentType: string,
    deployerClass: new (config: MultiCloudConfig) => MultiCloudDeployer
  ): void {
    if (!this.deployerRegistry.has(provider)) {
      this.deployerRegistry.set(provider, new Map());
    }

    this.deployerRegistry.get(provider)!.set(deploymentType, deployerClass);
  }
}

// Main orchestrator that uses the factory
class DeploymentOrchestrator {
  private config: MultiCloudConfig;
  private deployer: MultiCloudDeployer;
  private offlineServer: LocalDevServer | undefined;

  constructor() {
    this.config = loadConfig();
    this.deployer = new DeployerFactory(this.config);
  }

  async deploy(): Promise<void> {
    const stackName = this.deployer["generateStackName"]();

    try {
      this.validate();
      this.deployer.setFunctionsEnvironment();
      await this.package();

      console.log(
        `🚀 Starting deployment for ${this.config.provider}:${this.config.deploymentType}`
      );
      console.log(`📋 Service: ${this.config.service}-${this.config.stage}`);

      await this.deployer.deploy(stackName);
    } catch (error) {
      console.error("❌ Deployment failed:", error);
      process.exit(1);
    }
  }

  async package(): Promise<void> {
    try {
      console.log(
        `🚀 Starting packaging for ${this.config.provider}:${this.config.deploymentType}`
      );
      await this.deployer.package();
      console.log("✅ Packaging completed successfully!");
    } catch (error) {
      console.error("❌ Packaging failed:", error);
      process.exit(1);
    }
  }

  validate(): void {
    try {
      this.deployer.validate();
      console.log("✅ Configuration is valid!");
      console.log(`📋 Provider: ${this.config.provider}`);
      console.log(`📋 Type: ${this.config.deploymentType}`);
      console.log(`📋 Service: ${this.config.service}-${this.config.stage}`);
    } catch (error) {
      console.error("❌ Validation failed:", error);
      process.exit(1);
    }
  }

  // CLI command handlers
  async handleCommand(command: string, args: string[]): Promise<void> {
    switch (command) {
      case "offline":
        await this.offline();
        break;
      case "deploy":
        await this.deploy();
        break;

      case "package":
        await this.package();
        break;

      case "validate":
        this.validate();
        break;

      case "info":
        console.log("📋 Configuration Info:");
        console.log(JSON.stringify(this.config, null, 2));
        break;

      case "providers":
        console.log("🔧 Supported Providers and Deployment Types:");
        const combinations = DeployerFactory.getAllSupportedCombinations();
        const groupedByProvider = combinations.reduce(
          (acc, { provider, deploymentType }) => {
            if (!acc[provider]) acc[provider] = [];
            acc[provider].push(deploymentType);
            return acc;
          },
          {} as Record<string, string[]>
        );

        Object.entries(groupedByProvider).forEach(([provider, types]) => {
          console.log(`  ${provider}:`);
          types.forEach((type) => {
            console.log(`    - ${type}`);
          });
        });
        break;

      default:
        console.log(`❌ Unknown command: ${command}`);
        this.showHelp();
        process.exit(1);
    }
  }

  private showHelp(): void {
    console.log(`
  🚀 Multi-Cloud Deployment Tool
  
  Usage: npm run deploy <command> [options]
  
  Commands:
    deploy       Deploy the application using the config
    package      Package the application for deployment
    validate     Validate the configuration
    info         Show current configuration
    providers    List supported providers and types
    help         Show this help message
  
  Examples:
    npm run deploy deploy
    npm run deploy package
    npm run deploy validate
    npm run deploy info
    npm run deploy providers
  
  Configuration is loaded from config.ts automatically.
      `);
  }

  async offline(): Promise<void> {
    console.log("🚀 Starting offline server");
    try {
      this.deployer.validate();
    } catch (error) {
      console.warn(
        "⚠️  Configuration validation failed - running in offline mode with issues:"
      );
      console.warn(
        `   ${error instanceof Error ? error.message : String(error)}`
      );
      console.warn(
        "   🔧 Fix these issues before deploying to cloud providers"
      );
      console.warn(
        "   📝 Offline server will continue but may not behave like production"
      );
      console.warn("");
    }
    this.offlineServer = new LocalDevServer(this.config);
    await this.offlineServer.start();
    console.log("✅ Offline server started");
  }
}

// CLI Entry Point
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "help";

  const orchestrator = new DeploymentOrchestrator();

  if (command === "help") {
    orchestrator["showHelp"]();
    return;
  }

  try {
    await orchestrator.handleCommand(command, args.slice(1));
  } catch (error) {
    console.error("❌ Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Run if this file is executed directly (ES module compatible)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("💥 Fatal error:", error);
    process.exit(1);
  });
}

export { DeploymentOrchestrator };
