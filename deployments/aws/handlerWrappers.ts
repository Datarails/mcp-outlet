const generateApiError = async (defaultError, error) => {
  const response = {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Credentials": true,
    },
    statusCode: 500,
    body: JSON.stringify({ error: { message: defaultError } }),
  };

  if (error?.error?.statusCode && error?.error?.message) {
    response.statusCode = error.error.statusCode;
    response.body = JSON.stringify({ error: error.error });
  }

  return response;
};

// Safe JSON parser helper
const safeJsonParse = (jsonString) => {
  if (!jsonString) return {};

  try {
    return JSON.parse(jsonString);
  } catch (error) {
    console.warn("Failed to parse JSON body:", error.message);
    return {};
  }
};

// Extract and combine all parameters from Lambda API Gateway event
const extractUnifiedParams = (event) => {
  const pathParams = event.pathParameters || {};
  const queryParams = event.queryStringParameters || {};
  const bodyParams = safeJsonParse(event.body);

  // Merge all parameters with body taking lowest precedence
  // Order: pathParams override queryParams override bodyParams
  return {
    headers: event.headers,
    data: bodyParams,
    queryParams,
    pathParams,
  };
};

const handlerLambdaWrapper = (handler) => async (event, context) => {
  // Extract and unify all parameters
  const unifiedParams = extractUnifiedParams(event);

  // Call function with unified params as first argument
  const result = await handler(unifiedParams, context, event);
  if (result.success) {
    const contentType =
      result.headers?.["Content-Type"] || result.headers?.["content-type"];
    const shouldStringifyBody =
      !contentType ||
      contentType.startsWith("application/json") ||
      contentType.startsWith("application/graphql-response+json;");

    const response = {
      headers: {
        "Content-Type": "application/json",
        ...(result.headers ?? {}),
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
      },
      statusCode: result?.statusCode ?? 200,
      body: shouldStringifyBody
        ? result?.data && JSON.stringify(result.data)
        : result?.data,
    };

    return response;
  } else {
    return generateApiError("Error occurred in Lambda Wrapper", result.error);
  }
};

export { handlerLambdaWrapper };
