import { addLayerToPath, Layer } from "../shared.ts";

/**
 * Azure Function wrapper for MCP handlers
 * Transforms Azure Function context and request into standard format
 */
const generateApiError = async (defaultError, error) => {
  const response = {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Credentials": true,
    },
    status: 500,
    body: JSON.stringify({ error: { message: defaultError } }),
  };

  if (error?.error?.statusCode && error?.error?.message) {
    response.status = error.error.statusCode;
    response.body = JSON.stringify({ error: error.error });
  } else if (error?.statusCode && error?.message) {
    response.status = error.statusCode;
    response.body = JSON.stringify({ error: { message: error.message } });
  } else if (error?.message) {
    response.body = JSON.stringify({ error: { message: error.message } });
  }

  return response;
};

// Safe JSON parser helper
const safeJsonParse = (jsonString) => {
  if (!jsonString) return {};

  // Handle different Azure Function body formats
  if (typeof jsonString === "object") {
    return jsonString;
  }

  try {
    return JSON.parse(jsonString);
  } catch (error) {
    console.warn("Failed to parse JSON body:", error.message);
    return {};
  }
};

// Extract and combine all parameters from Azure Function event
const extractUnifiedParams = (request) => {
  const queryParams = request.query || {};
  const bodyParams = safeJsonParse(request.rawBody || request.body);
  const routeParams = request.params || {};

  // Merge all parameters with body taking lowest precedence
  // Order: routeParams override queryParams override bodyParams
  return {
    headers: request.headers,
    data: bodyParams,
    queryParams,
    pathParams: routeParams,
  };
};

const handlerAzureFunctionWrapper = (handler, layers: Layer[] = []) => {
  let isInit = false;

  return async (context, request) => {
    try {
      console.log(`[Azure Function] isInit: ${isInit}`);
      console.log(`[Azure Function] Initializing layers`);
      console.log(`[Azure Function] layers: ${JSON.stringify(layers)}`);
      await Promise.all(layers.map((layer) => addLayerToPath(layer)));

      isInit = true;
      console.log(
        `[Azure Function] Starting ${context.functionName || "unknown"}`
      );
      console.log(`[Azure Function] Request method: ${request.method}`);
      console.log(`[Azure Function] Request body type: ${typeof request.body}`);

      // Extract and unify all parameters
      const unifiedParams = extractUnifiedParams(request);
      console.log(
        `[Azure Function] Unified params keys: ${Object.keys(
          unifiedParams
        ).join(", ")}`
      );

      // Create Azure Function compatible context
      const azureContext = {
        invocationId: context.invocationId,
        functionName: context.functionName || "unknown",
        logGroupName: "/azure/functions/" + (context.functionName || "unknown"),
        logStreamName: context.invocationId,
        memoryLimitInMB: process.env.FUNCTIONS_MEMORY_SIZE || "128",
        callbackWaitsForEmptyEventLoop: false,
      };

      console.log(`[Azure Function] Calling handler with params`);

      // Call function with unified params as first argument
      const result = await handler(unifiedParams, azureContext, request);

      console.log(`[Azure Function] Handler result type: ${typeof result}`);
      console.log(
        `[Azure Function] Handler result keys: ${
          result ? Object.keys(result).join(", ") : "null"
        }`
      );

      // Handle different response formats from the handler
      if (result && typeof result === "object") {
        // Check if it's already a formatted response
        if (result.success !== undefined) {
          if (result.success) {
            const contentType =
              result.headers?.["Content-Type"] ||
              result.headers?.["content-type"];
            const shouldStringifyBody =
              !contentType ||
              contentType.startsWith("application/json") ||
              contentType.startsWith("application/graphql-response+json;");

            context.res = {
              headers: {
                "Content-Type": "application/json",
                ...(result.headers ?? {}),
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Credentials": true,
              },
              status: result?.statusCode ?? 200,
              body: shouldStringifyBody
                ? result?.data
                  ? JSON.stringify(result.data)
                  : JSON.stringify({})
                : result?.data,
            };
          } else {
            const errorResponse = await generateApiError(
              "Error occurred in Azure Function Wrapper",
              result.error
            );
            context.res = errorResponse;
          }
        } else {
          // Assume it's a direct JSON-RPC response from RPC handler
          context.res = {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Credentials": true,
            },
            status: 200,
            body: JSON.stringify(result),
          };
        }
      } else {
        // Handle null/undefined/primitive responses
        context.res = {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Credentials": true,
          },
          status: 200,
          body: JSON.stringify(result || {}),
        };
      }

      console.log(`[Azure Function] Response status: ${context.res.status}`);
    } catch (error) {
      console.error("Function execution failed:", error);
      console.error("Error stack:", error.stack);

      const errorResponse = await generateApiError("Internal Server Error", {
        error: { message: error.message, stack: error.stack },
      });
      context.res = errorResponse;
    }
  };
};

export { handlerAzureFunctionWrapper };
