import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { MultiCloudConfig } from "./shared.ts";

// Simplified handler interface
interface HandlerFunction {
  execute: (input: any, context: any) => Promise<any>;
}

export class LocalDevServer {
  private app: express.Application;
  private server?: any;

  constructor(private config: MultiCloudConfig) {
    this.app = express();
    this.config.tempFolder = this.config.package.outputDir + "/runtime";

    this.setupBaseMiddleware();
  }

  private setupBaseMiddleware(): void {
    // Only minimal global middleware
    this.app.use((req, res, next) => {
      console.log(`📨 ${req.method} ${req.path}`);
      next();
    });
  }

  async start(): Promise<void> {
    const port = this.config.offline?.port || 3000;

    // Register all functions from config
    await this.registerFunctions();

    // Start server
    return new Promise((resolve, reject) => {
      this.server = this.app
        .listen(port, () => {
          console.log(`🚀 Local server running on http://localhost:${port}`);
          this.logEndpoints();
          resolve();
        })
        .on("error", reject);

      // Graceful shutdown
      process.on("SIGINT", async () => {
        console.log("\n🛑 Shutting down local server...");
        await this.stop();
        process.exit(0);
      });
    });
  }

  private async registerFunctions(): Promise<void> {
    for (const func of this.config.functions) {
      try {
        // Create handler based on runtime type
        const handler = await this.createHandler(func);

        const nonHttpEvents = func.events?.filter(
          (event) => event.type !== "rest" && event.type !== "http"
        );
        if (nonHttpEvents?.length) {
          throw new Error(
            `Function ${func.name} has non-HTTP events: ${nonHttpEvents
              .map((event) => event.type)
              .join(", ")}`
          );
        }

        // Register REST endpoints
        for (const event of func.events || []) {
          if (
            (event.type === "rest" || event.type === "http") &&
            event.endpoint
          ) {
            this.registerRestEndpoint(func, handler, event);
          }
        }

        const handlerType =
          func.runtime?.type === "python" ? "python" : "typescript";
        console.log(`✅ Registered ${handlerType} function: ${func.name}`);
      } catch (error) {
        console.error(`❌ Failed to register ${func.name}:`, error);
      }
    }
  }

  private async createHandler(
    func: MultiCloudConfig["functions"][number]
  ): Promise<HandlerFunction> {
    const sourcePath = path.resolve(func.source);

    // Use runtime configuration to determine handler type
    if (func.runtime?.type === "python") {
      return this.createPythonHandler(func, sourcePath);
    } else {
      return this.createTypeScriptHandler(func, sourcePath);
    }
  }

  private async createTypeScriptHandler(
    func: MultiCloudConfig["functions"][number],
    sourcePath: string
  ): Promise<HandlerFunction> {
    // Import the TypeScript handler
    const handlerModule = await import(sourcePath);
    const handler = handlerModule[func.handler];

    if (!handler?.execute) {
      throw new Error(
        `Handler ${func.handler} not found or missing execute method`
      );
    }

    process.env["TEMP_FOLDER"] = this.config.tempFolder;
    return {
      execute: handler.execute.bind(handler),
    };
  }

  private createPythonHandler(
    func: MultiCloudConfig["functions"][number],
    sourcePath: string
  ): HandlerFunction {
    // Check if Python file exists
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Python handler file not found: ${sourcePath}`);
    }

    return {
      execute: async (input: any, context: any) => {
        return this.executePythonHandler(
          sourcePath,
          func.handler,
          input,
          context
        );
      },
    };
  }

  private async executePythonHandler(
    sourcePath: string,
    handlerName: string,
    input: any,
    context: any
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      // Simple Python execution script
      const pythonScript = `
import sys
import json
import os
import importlib.util
import asyncio
from dataclasses import dataclass
from typing import Dict, Any
os.environ["TEMP_FOLDER"] = "${this.config.tempFolder}"

# Set up Python project directory
source_path = r"${sourcePath}"
if "/src/python/" in source_path:
    python_project_dir = source_path.split("/src/python/")[0] + "/src/python"
    os.chdir(python_project_dir)

# Add source directory to Python path
source_dir = os.path.dirname(source_path)
if source_dir not in sys.path:
    sys.path.insert(0, source_dir)

try:
    # Import handler module
    spec = importlib.util.spec_from_file_location("handler_module", source_path)
    handler_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(handler_module)
    
    # Get handler
    handler = getattr(handler_module, "${handlerName}")
    
    # Read input from stdin
    input_data = json.loads(sys.stdin.read())
    
    # Create HandlerInput object from the data
    @dataclass
    class HandlerInput:
        data: Any
        headers: Dict[str, str]
        path_params: Dict[str, str]
        query_params: Dict[str, str]
    
    handler_input = HandlerInput(
        data=input_data["input"]["data"],
        headers=input_data["input"].get("headers", {}),
        path_params=input_data["input"].get("pathParams", {}),
        query_params=input_data["input"].get("queryParams", {})
    )
    
    # Execute handler
    if asyncio.iscoroutinefunction(handler.execute):
        result = asyncio.run(handler.execute(handler_input, input_data["context"]))
    else:
        result = handler.execute(handler_input, input_data["context"])
    
    # Return result - only JSON to stdout
    print(json.dumps({"success": True, "result": result}))
    
except Exception as e:
    import traceback
    print(json.dumps({"success": False, "error": str(e), "traceback": traceback.format_exc()}))
    sys.exit(1)
`;

      // Use uv directly with full path for this project
      const pythonCmd = "/Users/orishmila/.local/bin/uv";
      const args = ["run", "python", "-c", pythonScript];
      console.log("Using uv for Python execution");

      // Set working directory to Python project root
      const pythonProjectDir = sourcePath.includes("src/python/")
        ? path.join(process.cwd(), "src/python")
        : path.dirname(sourcePath);

      const pythonProcess = spawn(pythonCmd, args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: pythonProjectDir,
        env: {
          ...process.env,
          PYTHONPATH: path.dirname(sourcePath),
        },
      });

      let stdout = "";
      let stderr = "";

      pythonProcess.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      pythonProcess.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      pythonProcess.on("close", (code) => {
        console.log(`Python process closed with code: ${code}`);
        console.log(`Python STDOUT: ${stdout}`);
        console.log(`Python STDERR: ${stderr}`);

        if (code !== 0) {
          reject(
            new Error(
              `Python handler failed with code ${code}. STDOUT: ${stdout}. STDERR: ${stderr}`
            )
          );
          return;
        }

        try {
          const response = JSON.parse(stdout.trim());
          if (response.success) {
            resolve(response.result);
          } else {
            reject(new Error(`Python handler error: ${response.error}`));
          }
        } catch (e) {
          reject(
            new Error(
              `Failed to parse Python response: ${stdout}. Parse error: ${e}`
            )
          );
        }
      });

      pythonProcess.on("error", (error) => {
        reject(new Error(`Failed to spawn Python process: ${error.message}`));
      });

      // Send input data to Python
      const inputData = { input, context };
      console.log(
        `DEBUG: Sending to Python handler:`,
        JSON.stringify(inputData, null, 2)
      );
      pythonProcess.stdin.write(JSON.stringify(inputData));
      pythonProcess.stdin.end();
    });
  }

  private registerRestEndpoint(
    func: MultiCloudConfig["functions"][number],
    handler: HandlerFunction,
    event: MultiCloudConfig["functions"][number]["events"][number]
  ): void {
    const { path, methods } = event.endpoint;

    // Create middleware stack
    const middlewares = this.createEventMiddleware(func, event);

    for (const method of methods) {
      if (method === "OPTIONS") continue;

      const expressMethod = method.toLowerCase() as keyof Pick<
        express.Application,
        "get" | "post" | "put" | "delete"
      >;

      this.app[expressMethod](path, ...middlewares, async (req, res) => {
        try {
          console.log(`📨 ${req.method} ${req.path} - Function: ${func.name}`);

          // Create context for handler
          const context = {
            event: {
              httpMethod: req.method,
              path: req.path,
              pathParameters: req.params,
              queryStringParameters: req.query,
              headers: req.headers,
              body: req.body,
            },
            context: {
              requestId: `local-${Date.now()}`,
              functionName: func.name,
            },
          };

          const handlerInput = {
            data: req.body,
            queryParams: req.query,
            pathParams: req.params,
            headers: req.headers,
          };

          console.log(
            `DEBUG: Handler input:`,
            JSON.stringify(handlerInput, null, 2)
          );
          console.log(`DEBUG: Context:`, JSON.stringify(context, null, 2));

          const result = await handler.execute(handlerInput, context);

          // Handle response formats
          if (result?.statusCode) {
            res.status(result.statusCode).json(result.body || result);
          } else {
            res.json(result);
          }
        } catch (error) {
          const handlerType =
            func.runtime?.type === "python" ? "python" : "typescript";
          console.error(
            `❌ Error in ${handlerType} function ${func.name}:`,
            error
          );
          res.status(500).json({
            error: "Internal server error",
            message: error instanceof Error ? error.message : "Unknown error",
          });
        }
      });
    }

    console.log(`📍 ${methods.join(",")} ${path} → ${func.name}`);
  }

  private createEventMiddleware(
    func: MultiCloudConfig["functions"][number],
    event: MultiCloudConfig["functions"][number]["events"][number]
  ): express.RequestHandler[] {
    const middlewares: express.RequestHandler[] = [];

    // CORS configuration
    const corsConfig = event.cors || {
      origins: ["*"],
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      headers: ["Content-Type", "Authorization"],
    };
    if (corsConfig) {
      middlewares.push(cors(corsConfig));
    }

    // Body parsing with limits
    const bodyLimit = (func.bodyLimit as string | number) || "10mb";
    middlewares.push(express.json({ limit: bodyLimit }));
    middlewares.push(express.urlencoded({ extended: true, limit: bodyLimit }));

    return middlewares;
  }

  private logEndpoints(): void {
    const port = this.config.offline.port;
    console.log("\n📋 Available endpoints:");

    for (const func of this.config.functions) {
      for (const event of func.events || []) {
        if (
          (event.type === "rest" || event.type === "http") &&
          event.endpoint
        ) {
          console.log(`   http://localhost:${port}${event.endpoint.path}`);
        }
      }
    }
    console.log();
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          console.log("🛑 Local server stopped");
          resolve();
        });
      });
    }
  }
}
