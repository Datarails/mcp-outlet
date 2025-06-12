import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { CustomErrorResponseSchema } from "./schema.ts";

export const CustomErrorCode = ErrorCode;

export class CustomError extends McpError {
  toResponse() {
    return {
      code: this.code,
      message: this.message,
      ...(this.data && { data: this.data }),
    };
  }
}

export const formatError = (error: CustomError | unknown): CustomError => {
  let customError = error;
  if (!(customError instanceof CustomError)) {
    const isMcpError =
      (typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "McpError") ||
      CustomErrorResponseSchema.safeParse(error).success;

    if (isMcpError) {
      const casedError = error as CustomError;
      customError = new CustomError(
        casedError.code,
        casedError.message?.replace(`MCP error ${casedError.code}: `, ""),
        {
          ...(casedError.data && ((casedError.data as object) || {})),
        }
      );
    } else {
      const message =
        error && typeof error === "object" && "message" in error
          ? typeof error.message === "string"
            ? error.message
            : JSON.stringify(error.message)
          : null;
      customError = new CustomError(
        CustomErrorCode.InternalError,
        message || "Unknown error",
        message
          ? undefined
          : {
              error,
            }
      );
    }
  }
  return customError as CustomError;
};
