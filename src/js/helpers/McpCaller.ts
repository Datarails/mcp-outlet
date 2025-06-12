import {
  McpServerConfiguration,
  McpServerConfigurationSchema,
} from "./schema.ts";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CustomError, CustomErrorCode, formatError } from "./error.ts";
import {
  isJSONRPCError,
  isJSONRPCResponse,
  JSONRPCResponse,
  JSONRPCError,
  JSONRPCRequest,
  JSONRPCNotification,
  InitializeResult,
  InitializeResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Tracer } from "./tracer.ts";
import { rmSync } from "node:fs";

interface TimeoutInfo {
  timeoutId: NodeJS.Timeout;
  onTimeout: () => void;
}

export class McpCaller {
  private _transport: StdioClientTransport | undefined;
  private _requestMessageId = 1;
  private _responseHandlers = new Map<number, (response: any) => void>();
  private _timeoutInfo = new Map<number, TimeoutInfo>();
  private _isConnected = false;
  private config: McpServerConfiguration;
  private serverInfo: InitializeResult;

  constructor(config: McpServerConfiguration) {
    this.config = McpServerConfigurationSchema.parse(config);
  }

  async connect(): Promise<InitializeResult> {
    if (this._isConnected && this._transport) {
      return this.serverInfo;
    }

    this._transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      env: this.config.env,
      stderr: this.config.stderr,
      cwd: this.config.cwd,
    });

    // Set up event handlers exactly like the original SDK
    this._transport.onclose = () => {
      this._onclose();
    };

    this._transport.onerror = (error) => {
      this._onerror(error);
    };

    this._transport.onmessage = (message) => {
      if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
        this._onresponse(message);
      } else if (message.method) {
      } else {
        this._onerror(
          new CustomError(
            CustomErrorCode.InvalidRequest,
            `Unknown message type`,
            {
              message,
            }
          )
        );
      }
    };

    // Start the transport
    await this._transport.start();
    this._isConnected = true;
    const initializeResponse = await this.executeMcpCall({
      jsonrpc: this.config.jsonrpc,
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: this.config.protocolVersion,
        capabilities: {},
        clientInfo: {
          name: "mcp-outlet",
          version: "1.0.0",
        },
      },
    });
    this.serverInfo = InitializeResultSchema.parse(
      (initializeResponse as JSONRPCResponse).result
    );

    await this._transport.send({
      jsonrpc: this.config.jsonrpc,
      method: "notifications/initialized",
      params: {},
    });
    return this.serverInfo;
  }

  async close(): Promise<void> {
    if (this._transport) {
      await this._transport.close();
    }
  }

  // Replicate the exact _onclose logic from the SDK
  private _onclose(): void {
    this._responseHandlers = new Map();
    this._transport = undefined;
    this._isConnected = false;

    // Clean up all timeouts
    for (const [messageId] of this._timeoutInfo) {
      this._cleanupTimeout(messageId);
    }

    if (process.env.TEMP_FOLDER) {
      rmSync(process.env.TEMP_FOLDER, { recursive: true, force: true });
    }
  }

  private _onerror(error: unknown): void {
    throw formatError(error);
  }

  // Replicate the exact _onresponse logic from the SDK
  private _onresponse(response: JSONRPCResponse | JSONRPCError): void {
    const messageId = Number(response.id);
    const handler = this._responseHandlers.get(messageId);

    if (handler === undefined) {
      this._onerror(
        new CustomError(
          CustomErrorCode.InvalidRequest,
          `Received a response for an unknown message ID`,
          {
            response,
          }
        )
      );
      return;
    }

    this._responseHandlers.delete(messageId);
    this._cleanupTimeout(messageId);

    if (isJSONRPCResponse(response)) {
      handler(response);
    } else {
      const error = formatError(response.error);
      handler(error);
    }
  }

  private _setupTimeout(
    messageId: number,
    timeout: number,
    onTimeout: () => void
  ): void {
    this._cleanupTimeout(messageId); // Clean up any existing timeout
    this._timeoutInfo.set(messageId, {
      timeoutId: setTimeout(onTimeout, timeout),
      onTimeout,
    });
  }

  private _cleanupTimeout(messageId: number): void {
    const info = this._timeoutInfo.get(messageId);
    if (info) {
      clearTimeout(info.timeoutId);
      this._timeoutInfo.delete(messageId);
    }
  }

  async executeMcpCall(
    input: JSONRPCRequest,
    tracer?: Tracer
  ): Promise<JSONRPCResponse | JSONRPCNotification> {
    // Ensure we're connected
    if (!this._isConnected || !this._transport) {
      throw new CustomError(CustomErrorCode.ConnectionClosed, "Not connected");
    }
    if (input.method === "initialize" && this.serverInfo) {
      return {
        jsonrpc: this.config.jsonrpc,
        id: input.id,
        result: this.serverInfo,
      };
    }

    const capturedLogs: string[] = [];

    // Store originals and set up console capture
    const originalMethods = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      info: console.info,
    };

    const safeCapture =
      (level: string, originalMethod: Function) =>
      (...args: any[]) => {
        try {
          const message = args
            .map((arg) => {
              try {
                return typeof arg === "object"
                  ? JSON.stringify(arg)
                  : String(arg);
              } catch (e) {
                return "[Circular/Error in JSON.stringify]";
              }
            })
            .join(" ");
          capturedLogs.push(`[${level}] ${message}`);
          originalMethod.apply(console, args);
        } catch (e) {
          originalMethod.apply(console, args);
        }
      };

    console.log = safeCapture("LOG", originalMethods.log);
    console.warn = safeCapture("WARN", originalMethods.warn);
    console.error = safeCapture("ERROR", originalMethods.error);
    console.info = safeCapture("INFO", originalMethods.info);

    try {
      if (!this._transport) {
        throw new Error("Not connected");
      }

      const callMeta = {
        ...(input?.params?._meta || {}),
        tempFolder: process.env.TEMP_FOLDER,
      };

      const messageId = this._requestMessageId++;

      // Create the JSON-RPC request exactly like the SDK does
      const jsonrpcRequest = {
        ...input,
        jsonrpc: "2.0",
        id: messageId,
        params: { ...input.params, _meta: callMeta },
      };

      // Create promise and set up response handler BEFORE sending
      const responsePromise = new Promise<
        JSONRPCResponse | JSONRPCNotification
      >((resolve, reject) => {
        const timeout = 30000; // 30 seconds

        const cancel = (reason: unknown) => {
          this._responseHandlers.delete(messageId);
          this._cleanupTimeout(messageId);
          reject(reason);
        };

        const timeoutHandler = () => {
          cancel(
            new CustomError(
              CustomErrorCode.RequestTimeout,
              `Request timed out`,
              {
                messageId,
                timeout,
              }
            )
          );
        };

        // Set up timeout
        this._setupTimeout(messageId, timeout, timeoutHandler);

        // Store response handler - this is crucial
        this._responseHandlers.set(messageId, (response: any) => {
          if (response instanceof Error || isJSONRPCError(response)) {
            reject(response);
          } else {
            resolve(response);
          }
        });
      });

      // Send the request - make sure to await this
      try {
        await this._transport.send(jsonrpcRequest as JSONRPCRequest);
      } catch (sendError) {
        this._responseHandlers.delete(messageId);
        this._cleanupTimeout(messageId);
        throw sendError;
      }

      // Wait for the response
      const result = await responsePromise;
      // Handle tracing for successful response
      let resultTrace: any = [];
      if (result && typeof result === "object" && "_meta" in result) {
        const resultMeta = (result as any)._meta;
        if (resultMeta?.trace) {
          resultTrace = resultMeta.trace;
        }
      }

      if (tracer) {
        tracer.mergeChildTrace(
          "executeMcpCall",
          "executeMcpCall",
          true,
          resultTrace,
          {
            ...(capturedLogs?.length > 0 ? { logs: capturedLogs } : {}),
          }
        );
      }

      return result;
    } catch (error) {
      // Handle tracing for error response
      if (error && typeof error === "object" && "_meta" in error) {
        const resultMeta = (error as any)._meta;
        if (resultMeta?.trace) {
          if (tracer) {
            tracer.mergeChildTrace(
              "mcpCall.server",
              "mcpCall",
              false,
              resultMeta.trace,
              {
                ...(capturedLogs?.length > 0 ? { logs: capturedLogs } : {}),
              }
            );
          }
        }
      }
      throw error;
    } finally {
      // Restore console
      console.log = originalMethods.log;
      console.warn = originalMethods.warn;
      console.error = originalMethods.error;
      console.info = originalMethods.info;
    }
  }
}
