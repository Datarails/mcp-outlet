import { build, context, BuildOptions, BuildContext } from "esbuild";
import { glob } from "glob";
import { minimatch } from "minimatch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { MultiCloudConfig } from "../shared.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Type definitions
interface FunctionConfig {
  source: string;
  name: string;
  exportName: string;
  target: string;
  wrapper?: {
    path: string; // Path to the wrapper module
    export: string; // Export name from the wrapper module
    layers?: any[]; // Optional layers to pass to wrapper
  };
}

class ESBuildServerless {
  private config: MultiCloudConfig["package"];
  private watchMode: boolean;
  private contexts: Map<string, BuildContext>;

  constructor(config: MultiCloudConfig["package"]) {
    this.config = config;
    this.watchMode = process.argv.includes("--watch");
    this.contexts = new Map();
  }

  // Process glob patterns with exclude support
  processPatterns(patterns: string[]): string[] {
    const includePatterns = patterns.filter((p) => !p.startsWith("!"));
    const excludePatterns = patterns
      .filter((p) => p.startsWith("!"))
      .map((p) => p.slice(1));

    let allFiles: string[] = [];

    for (const pattern of includePatterns) {
      const files = glob.sync(pattern);
      allFiles = [...allFiles, ...files];
    }

    allFiles = [...new Set(allFiles)];

    if (excludePatterns.length > 0) {
      allFiles = allFiles.filter((file) => {
        return !excludePatterns.some((excludePattern) => {
          return minimatch(file, excludePattern);
        });
      });
    }

    return allFiles;
  }

  // Clean output directory
  cleanOutput(): void {
    // Only clean JS files, not the entire output directory
    // This allows multiple builders to coexist
    if (fs.existsSync(this.config.outputDir)) {
      const files = fs.readdirSync(this.config.outputDir);
      files.forEach((file) => {
        if (file.endsWith(".js") || file.endsWith(".js.map")) {
          const filePath = path.join(this.config.outputDir, file);
          fs.rmSync(filePath, { force: true });
        }
      });
    }
    fs.mkdirSync(this.config.outputDir, { recursive: true });
  }

  // Get build options for a specific file
  getBuildOptions(inputFile: string, outputFile: string): BuildOptions {
    return {
      entryPoints: [inputFile],
      outfile: outputFile,
      external: this.config.esbuild.external,
      bundle: this.config.esbuild.bundle,
      minify: this.config.esbuild.minify,
      format: this.config.esbuild.format as any,
      platform: this.config.esbuild.platform as any,
      target: this.config.esbuild.target,
      mainFields: this.config.esbuild.mainFields,
      conditions: this.config.esbuild.conditions,
      banner: this.config.esbuild.banner,
      sourcemap: process.env.NODE_ENV === "development",
      logLevel: "info",
      metafile: false,
    };
  }

  // Create wrapper function content with proper imports
  createWrapperFunction(functionConfig: FunctionConfig): string {
    const { name, wrapper, source } = functionConfig;

    if (!wrapper) {
      return "";
    }

    // Resolve paths relative to where the wrapper file will be created
    const wrapperDir = path.dirname(
      path.resolve(this.config.outputDir, functionConfig.target)
    );

    const relativeSourcePath = path
      .relative(wrapperDir, path.resolve(source))
      .replace(/\\/g, "/");

    const relativeWrapperPath = path
      .relative(wrapperDir, path.resolve(wrapper.path))
      .replace(/\\/g, "/");

    // Add .js extension for relative imports if not present
    const sourceImportPath = relativeSourcePath.startsWith(".")
      ? relativeSourcePath.replace(/\.ts$/, ".js")
      : relativeSourcePath;

    const wrapperImportPath = relativeWrapperPath.startsWith(".")
      ? relativeWrapperPath.replace(/\.ts$/, ".js")
      : relativeWrapperPath;

    const layersCode = wrapper.layers
      ? `, ${JSON.stringify(wrapper.layers)}`
      : "";

    // Generate proper wrapper code with imports
    return `// Auto-generated wrapper for ${name}
import { ${name} } from '${sourceImportPath}';
import { ${wrapper.export} } from '${wrapperImportPath}';

// Apply wrapper transformation
export const ${functionConfig.exportName} = ${wrapper.export}(${name}.execute${layersCode});
`;
  }

  // Build function with configuration
  async buildFunctionWithConfig(functionConfig: FunctionConfig): Promise<void> {
    const { source, name, target, wrapper } = functionConfig;

    console.log(`🔨 Building function: ${name}`);

    const outputDir = path.join(this.config.outputDir, path.dirname(target));
    const outputPath = path.join(this.config.outputDir, target);

    fs.mkdirSync(outputDir, { recursive: true });

    // If wrapper is provided, create a wrapper entry point
    if (wrapper) {
      // Create wrapper file
      const wrapperContent = this.createWrapperFunction(functionConfig);
      const wrapperPath = path.join(outputDir, `${name}_wrapper.ts`);
      fs.writeFileSync(wrapperPath, wrapperContent);

      if (this.watchMode) {
        // Build wrapper (which will bundle the original function and wrapper dependencies)
        const wrapperBuildOptions = this.getBuildOptions(
          wrapperPath,
          outputPath
        );
        const wrapperCtx = await context(wrapperBuildOptions);
        this.contexts.set(`${source}-wrapper`, wrapperCtx);
        await wrapperCtx.watch();

        console.log(`👀 Watching: ${name} (with wrapper)`);
      } else {
        // Build wrapper (which will bundle everything)
        const wrapperBuildOptions = this.getBuildOptions(
          wrapperPath,
          outputPath
        );
        await build(wrapperBuildOptions);

        // Clean up temporary wrapper file
        if (fs.existsSync(wrapperPath)) {
          fs.unlinkSync(wrapperPath);
        }

        console.log(`✅ Built: ${name} (with wrapper)`);
      }
    } else {
      // No wrapper, build directly
      await this.buildFunction(source, target);
    }
  }

  // Updated buildFunction to support custom target
  async buildFunction(file: string, customTarget?: string): Promise<void> {
    const relativePath = path.relative(process.cwd(), file);
    const outputPath = customTarget
      ? path.join(this.config.outputDir, customTarget)
      : path.join(this.config.outputDir, relativePath.replace(/\.ts$/, ".js"));
    const outputDir = path.dirname(outputPath);

    fs.mkdirSync(outputDir, { recursive: true });

    const buildOptions = this.getBuildOptions(file, outputPath);

    if (this.watchMode) {
      const ctx = await context(buildOptions);
      this.contexts.set(file, ctx);
      await ctx.watch();
      console.log(`👀 Watching: ${customTarget || relativePath}`);
    } else {
      await build(buildOptions);
      console.log(`✅ Built: ${customTarget || relativePath}`);
    }
  }

  // Copy non-JS files
  copyFile(file: string): void {
    const relativePath = path.relative(process.cwd(), file);
    const outputPath = path.join(this.config.outputDir, relativePath);
    const outputDir = path.dirname(outputPath);

    fs.mkdirSync(outputDir, { recursive: true });
    fs.copyFileSync(file, outputPath);
    console.log(`📄 Copied: ${relativePath}`);
  }

  // Main build function - now accepts function configurations
  async build(functionConfigs?: FunctionConfig[]): Promise<void> {
    try {
      console.log("🚀 Starting build process...");

      if (!this.watchMode) {
        this.cleanOutput();
      }

      // If function configs are provided, use them
      if (functionConfigs && functionConfigs.length > 0) {
        console.log(
          `📦 Found ${functionConfigs.length} configured functions to build`
        );

        const buildPromises = functionConfigs.map((config) =>
          this.buildFunctionWithConfig(config)
        );
        await Promise.all(buildPromises);
      } else {
        // Fallback to pattern-based building
        const matchedFiles = this.processPatterns(this.config.patterns);
        const tsFiles = matchedFiles.filter((file) => file.endsWith(".ts"));
        const otherFiles = matchedFiles.filter((file) => !file.endsWith(".ts"));

        console.log(`📦 Found ${tsFiles.length} TypeScript files to bundle`);
        console.log(`📄 Found ${otherFiles.length} other files to copy`);

        const buildPromises = tsFiles.map((file) => this.buildFunction(file));
        await Promise.all(buildPromises);

        otherFiles.forEach((file) => this.copyFile(file));
      }

      if (this.watchMode) {
        console.log("👀 Watching for changes... Press Ctrl+C to stop");

        process.on("SIGINT", async () => {
          console.log("\n🛑 Stopping watchers...");
          for (const ctx of this.contexts.values()) {
            await ctx.dispose();
          }
          process.exit(0);
        });
      } else {
        console.log("✅ Build completed successfully!");
      }
    } catch (error) {
      console.error("❌ Build failed:", error);
      process.exit(1);
    }
  }
}

// Export the configured builder
export { ESBuildServerless, type FunctionConfig };
