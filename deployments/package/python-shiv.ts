import { execSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { MultiCloudConfig } from "../shared.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Type definitions for Python functions
export interface PythonFunctionConfig {
  source: string;
  name: string;
  target: string;
  handler: string;
  wrapper?: {
    path: string; // Path to the wrapper module
    export: string; // Export name from the wrapper
    layers?: any[]; // Optional layers to pass to wrapper
  };
}

export class PythonShivPackager {
  private config: MultiCloudConfig["package"];
  private uvPath: string;

  constructor(config: MultiCloudConfig["package"]) {
    this.config = config;
    this.uvPath = this.findUvPath();
  }

  // Find uv executable path
  private findUvPath(): string {
    const possiblePaths = [
      "/Users/orishmila/.local/bin/uv", // From setup script
      "uv", // Global install
      process.env.UV_PATH || "",
    ].filter(Boolean);

    for (const uvPath of possiblePaths) {
      try {
        execSync(`${uvPath} --version`, { stdio: "ignore" });
        console.log(`✅ Found uv at: ${uvPath}`);
        return uvPath;
      } catch (error) {
        // Continue to next path
      }
    }

    throw new Error(
      "uv not found. Please install uv: curl -LsSf https://astral.sh/uv/install.sh | sh"
    );
  }

  // Clean output directory
  cleanOutput(): void {
    // Only clean Python files, not the entire output directory
    // This allows multiple builders to coexist
    if (fs.existsSync(this.config.outputDir)) {
      const files = fs.readdirSync(this.config.outputDir);
      files.forEach((file) => {
        if (file.endsWith(".pyz") || file.endsWith(".py")) {
          const filePath = path.join(this.config.outputDir, file);
          fs.rmSync(filePath, { force: true });
        }
      });
    }
    fs.mkdirSync(this.config.outputDir, { recursive: true });
  }

  // Get Python project directory from source path
  private getPythonProjectDir(sourcePath: string): string {
    // For python package structure, use src/python as the project root where pyproject.toml is located
    if (sourcePath.includes("src/python/")) {
      return path.join(process.cwd(), "src/python");
    }
    // Otherwise use the directory containing the source file
    return path.dirname(path.resolve(sourcePath));
  }

  // Install dependencies using uv
  private async installDependencies(projectDir: string): Promise<void> {
    console.log(`📦 Installing Python dependencies in ${projectDir}...`);

    try {
      // Check if pyproject.toml exists
      const pyprojectPath = path.join(projectDir, "pyproject.toml");
      if (!fs.existsSync(pyprojectPath)) {
        throw new Error(`pyproject.toml not found in ${projectDir}`);
      }

      // Install dependencies using uv
      execSync(`${this.uvPath} sync`, {
        cwd: projectDir,
        stdio: "inherit",
      });

      console.log("✅ Dependencies installed successfully");
    } catch (error) {
      console.error("❌ Failed to install dependencies:", error.message);
      throw error;
    }
  }

  // Create shiv package
  private async createShivPackage(
    functionConfig: PythonFunctionConfig,
    projectDir: string,
    tempDir: string
  ): Promise<void> {
    const { name, target, handler } = functionConfig;
    // Ensure target has .pyz extension but don't double-add it
    const finalTarget = target.endsWith(".pyz") ? target : target + ".pyz";
    const outputPath = path.join(this.config.outputDir, finalTarget);

    console.log(`🔨 Creating shiv package for: ${name}`);

    try {
      // Ensure output directory exists
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });

      // Prepare entry point
      let entryPoint: string;

      // Create entry point from source path relative to src directory
      if (functionConfig.source.includes("src/python/")) {
        // For python package structure: src/python/handlers/rpc.py -> python.handlers.rpc:handler_name
        const relativePath = functionConfig.source
          .replace(/.*src\//, "") // Remove everything up to and including src/
          .replace(/\.py$/, "") // Remove .py extension
          .replace(/\//g, "."); // Convert slashes to dots
        entryPoint = `${relativePath}:${handler}`;
      } else {
        // Fallback for other structures
        const handlerModule = functionConfig.source
          .replace(/^src\/python\//, "")
          .replace(/\.py$/, "")
          .replace(/\//g, ".");
        entryPoint = `${handlerModule}:${handler}`;
      }

      // Create a temporary package directory
      const packageDir = path.join(tempDir, "package");
      fs.mkdirSync(packageDir, { recursive: true });

      // Copy the python package to the temp directory
      const srcDir = path.join(process.cwd(), "src");
      const pythonPackageSource = path.join(srcDir, "python");
      const pythonPackageDest = path.join(packageDir, "python");

      // Copy the entire python package
      this.copyDirectory(pythonPackageSource, pythonPackageDest);

      // Create a minimal setup.py in the package directory so shiv can install it
      const setupPyContent = `
from setuptools import setup, find_packages

setup(
    name="mcp-outlet-python",
    version="1.0.0",
    packages=find_packages(),
    install_requires=[],
)
`;
      fs.writeFileSync(path.join(packageDir, "setup.py"), setupPyContent);

      // Find the correct site-packages path from the python project directory
      const sitePackagesPath = this.findSitePackagesPath(projectDir);

      // Create shiv command - run from the package directory
      const shivArgs = [
        "tool",
        "run",
        "shiv",
        "--site-packages",
        sitePackagesPath,
        "--compressed",
        "--no-deps",
        "--entry-point",
        entryPoint,
        "--output-file",
        path.resolve(outputPath),
        ".",
      ];

      console.log(`🔧 Shiv command: ${this.uvPath} ${shivArgs.join(" ")}`);
      console.log(`🔧 Working directory: ${packageDir}`);
      console.log(`🔧 Entry point: ${entryPoint}`);

      // Execute shiv command from package directory
      execSync(`${this.uvPath} ${shivArgs.join(" ")}`, {
        cwd: packageDir,
        stdio: "inherit",
        env: {
          ...process.env,
          PYTHONPATH: packageDir,
        },
      });

      console.log(`✅ Created shiv package: ${finalTarget}`);
    } catch (error) {
      console.error(
        `❌ Failed to create shiv package for ${name}:`,
        error.message
      );
      throw error;
    }
  }

  // Helper method to copy directory recursively
  private copyDirectory(src: string, dest: string): void {
    if (!fs.existsSync(src)) {
      throw new Error(`Source directory does not exist: ${src}`);
    }

    fs.mkdirSync(dest, { recursive: true });

    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        // Skip __pycache__ and .venv directories
        if (entry.name === "__pycache__" || entry.name === ".venv") {
          continue;
        }
        this.copyDirectory(srcPath, destPath);
      } else {
        // Skip .pyc files
        if (entry.name.endsWith(".pyc")) {
          continue;
        }
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  // Build function with configuration
  async buildFunctionWithConfig(
    functionConfig: PythonFunctionConfig
  ): Promise<void> {
    const { source, name } = functionConfig;
    const projectDir = this.getPythonProjectDir(source);
    const tempDir = path.join(this.config.outputDir, "temp");

    // Create temp directory
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      // Install dependencies
      await this.installDependencies(projectDir);

      // Create shiv package
      await this.createShivPackage(functionConfig, projectDir, tempDir);
    } finally {
      // Clean up temp directory
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }

  // Build multiple functions
  async build(functionConfigs: PythonFunctionConfig[]): Promise<void> {
    console.log("🐍 Building Python functions with shiv...");

    // Clean output directory
    this.cleanOutput();

    // Build each function
    for (const config of functionConfigs) {
      await this.buildFunctionWithConfig(config);
    }

    console.log("✅ All Python functions built successfully!");
  }

  // Find site-packages path in virtual environment
  private findSitePackagesPath(projectDir: string): string {
    const venvDir = path.join(projectDir, ".venv");

    if (!fs.existsSync(venvDir)) {
      throw new Error(
        `Virtual environment not found at ${venvDir}. Run 'uv sync' first.`
      );
    }

    try {
      // Find Python version directories
      const libDir = path.join(venvDir, "lib");
      if (fs.existsSync(libDir)) {
        const pythonDirs = fs
          .readdirSync(libDir)
          .filter((dir) => dir.startsWith("python"))
          .sort()
          .reverse(); // Get the latest Python version

        if (pythonDirs.length > 0) {
          const sitePackagesPath = path.join(
            libDir,
            pythonDirs[0],
            "site-packages"
          );
          if (fs.existsSync(sitePackagesPath)) {
            return sitePackagesPath;
          }
        }
      }

      // Fallback: try pyvenv.cfg to determine Python version
      const pyvenvPath = path.join(venvDir, "pyvenv.cfg");
      if (fs.existsSync(pyvenvPath)) {
        const content = fs.readFileSync(pyvenvPath, "utf-8");
        const versionMatch = content.match(/version\s*=\s*(\d+\.\d+)/);
        if (versionMatch) {
          const version = versionMatch[1];
          const sitePackagesPath = path.join(
            venvDir,
            "lib",
            `python${version}`,
            "site-packages"
          );
          if (fs.existsSync(sitePackagesPath)) {
            return sitePackagesPath;
          }
        }
      }
    } catch (error) {
      console.warn(
        "Warning: Could not auto-detect site-packages path:",
        error.message
      );
    }

    // Ultimate fallback
    throw new Error(`Could not find site-packages directory in ${venvDir}`);
  }

  // Get dependencies from pyproject.toml
  private getDependencies(projectDir: string): string[] {
    const pyprojectPath = path.join(projectDir, "pyproject.toml");
    if (!fs.existsSync(pyprojectPath)) {
      return [];
    }

    try {
      // Simple parsing of pyproject.toml for dependencies
      const content = fs.readFileSync(pyprojectPath, "utf-8");
      const dependencyMatch = content.match(
        /dependencies\s*=\s*\[([\s\S]*?)\]/
      );

      if (dependencyMatch) {
        const deps = dependencyMatch[1]
          .split(/[,\n]/)
          .map((dep) => dep.trim().replace(/['"]/g, ""))
          .filter((dep) => dep && !dep.startsWith("#"));
        return deps;
      }
    } catch (error) {
      console.warn("Warning: Could not parse dependencies from pyproject.toml");
    }

    return [];
  }
}
