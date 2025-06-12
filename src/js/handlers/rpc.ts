import {
  JSONRPCNotification,
  JSONRPCNotificationSchema,
  JSONRPCRequest,
  JSONRPCRequestSchema,
  JSONRPCResponseSchema,
  SetLevelRequest,
  PingRequest,
} from "@modelcontextprotocol/sdk/types.js";
import z from "zod";
import { Tracer } from "../helpers/tracer.ts";
import { CustomError, CustomErrorCode, formatError } from "../helpers/error.ts";
import { CustomRequestMetaSchema } from "../helpers/schema.ts";
import {
  getTraceId,
  HandlerConfiguration,
  HandlerInput,
  RuntimeContext,
} from "./helpers.ts";
import { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { McpCaller } from "../helpers/McpCaller.ts";

export const generateJSONRPCResponse = (
  data: JSONRPCRequest | JSONRPCNotification,
  tracer: Tracer = undefined,
  result: Record<string, unknown> = undefined,
  error: ReturnType<CustomError["toResponse"]> = undefined
) => {
  const parsed = CustomRequestMetaSchema.safeParse(data?.params?._meta);
  const customMetadata = {
    ...(parsed.success && {
      server: parsed.data.server,
    }),
    ...(tracer && { trace: tracer.getTrace(!error) }),
  };

  if (error) {
    return {
      ...(!!data && "id" in data && { id: data.id }),
      jsonrpc: data?.jsonrpc,
      error: {
        ...error,
        data: {
          ...(error.data && typeof error.data === "object" ? error.data : {}),
          _meta: {
            ...customMetadata,
            ...(error.data &&
            typeof error.data === "object" &&
            "_meta" in error.data &&
            typeof error.data._meta === "object"
              ? error.data._meta
              : {}),
          },
        },
      },
    };
  }

  return {
    ...(!!data && "id" in data && { id: data.id }),
    jsonrpc: data?.jsonrpc,
    result: {
      ...result,
      _meta: {
        ...(result?._meta && typeof result._meta === "object"
          ? result._meta
          : {}),
        ...customMetadata,
      },
    },
  };
};

const handlersMap = {
  //  these are working in mcp-outlet level and not in mcp-server level
  ping: (_params: PingRequest, _options: RequestOptions) => {
    return { result: undefined };
  },
  "logging/setLevel": (params: SetLevelRequest, _options: RequestOptions) => {
    return { result: { _meta: { traceLevel: params.params.level } } };
  },
  "notifications/initialized": (
    _params: Notification,
    _options: RequestOptions
  ) => {
    return { result: undefined };
  },

  //  These are working in mcp-server level so we don't need to implement them here
  initialize: true,
  "prompts/get": true,
  "prompts/list": true,
  "resources/list": true,
  "resources/templates/list": true,
  "resources/read": true,
  "tools/call": true,
  "tools/list": true,
  "completion/complete": true,

  //  Not supported by outlet (all notifications except initialized are not)
  "notifications/roots/list_changed": false,
  "resources/unsubscribe": false,
  "resources/subscribe": false,
  "sampling/createMessage": false,
  "roots/list": false,
};

const rpcHandler = async (
  input: HandlerInput<JSONRPCNotification | JSONRPCRequest>,
  context: RuntimeContext
) => {
  const tracer = new Tracer(getTraceId(input, "id"));
  let mcpCaller: McpCaller | undefined = undefined;
  try {
    // If its tunning on aws wait to complete all for prevent race condition
    if ("callbackWaitsForEmptyEventLoop" in context) {
      context.callbackWaitsForEmptyEventLoop = true;
    }

    tracer.recordSpan(`inputValidation`);
    const metaParams = CustomRequestMetaSchema.safeParse(
      input?.data?.params?._meta
    );
    if (!metaParams.success) {
      throw new CustomError(
        CustomErrorCode.InvalidRequest,
        "Request _meta must be including correct server configuration",
        {
          reason: metaParams.error.message,
        }
      );
    }
    const handler = handlersMap[input?.data?.method || ""];
    if (!handler) {
      throw new CustomError(
        CustomErrorCode.MethodNotFound,
        `Rpc supporting only ${Object.entries(handlersMap)
          .filter(([_, value]) => value !== false)
          .map(([key]) => key)
          .join(", ")} methods`
      );
    }

    if (typeof handler === "function") {
      tracer.recordSpan(`outletHandler`);
      const result = await handler(input.data, context);
      return generateJSONRPCResponse(input.data, tracer, result.result);
    }

    // Notifications cant works with serverHandler
    const messageArgs = input.data as JSONRPCRequest;
    tracer.recordSpan(`connectToServer`);
    mcpCaller = new McpCaller(metaParams.data.server);
    await mcpCaller.connect();

    tracer.recordSpan(`executeMcpCall`, null, {
      method: messageArgs.method,
    });
    const result = await mcpCaller.executeMcpCall(messageArgs, tracer);
    return generateJSONRPCResponse(
      messageArgs,
      tracer,
      "result" in result ? result?.result : result
    );
  } catch (error) {
    const formattedError = formatError(error);
    return generateJSONRPCResponse(
      input?.data,
      tracer,
      undefined,
      formattedError.toResponse()
    );
  } finally {
    await mcpCaller?.close();
  }
};

export const rpc: HandlerConfiguration<JSONRPCRequest | JSONRPCNotification> = {
  name: "rpc",
  inputSchema: z.union([JSONRPCRequestSchema, JSONRPCNotificationSchema]),
  outputSchema: JSONRPCResponseSchema,
  execute: rpcHandler,
};
