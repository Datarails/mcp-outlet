"""Error handling for MCP Outlet Python implementation.

This module provides custom error classes that mirror the TypeScript implementation
to ensure consistent error handling and response formatting.
"""

from typing import Dict, Any, Optional
from app.helpers.schema import CustomErrorResponse


# Mirror TypeScript ErrorCode enum
class CustomErrorCode:
    """Error codes matching the MCP SDK ErrorCode enum."""

    # Standard JSON-RPC error codes
    PARSE_ERROR = -32700
    INVALID_REQUEST = -32600
    METHOD_NOT_FOUND = -32601
    INVALID_PARAMS = -32602
    INTERNAL_ERROR = -32603

    # MCP-specific error codes
    CONNECTION_CLOSED = -32001
    REQUEST_TIMEOUT = -32002


class CustomError(Exception):
    """Custom error class that mirrors the TypeScript CustomError class."""

    def __init__(self, code: int, message: str, data: Optional[Dict[str, Any]] = None):
        self.code = code
        self.message = message
        self.data = data
        super().__init__(message)

    def to_response(self) -> Dict[str, Any]:
        """Convert error to JSON-RPC error response format."""
        response = {"code": self.code, "message": self.message}
        if self.data:
            response["data"] = self.data
        return response


def format_error(error: Any) -> CustomError:
    """Format any error to CustomError, mirroring the TypeScript formatError function."""

    if isinstance(error, CustomError):
        return error

    # Check if it's an MCP error or JSON-RPC error structure
    if isinstance(error, dict) and "code" in error and "message" in error:
        try:
            # Validate it matches CustomErrorResponse structure
            error_response = CustomErrorResponse(**error)
            return CustomError(
                code=error_response.code,
                message=error_response.message.replace(
                    f"MCP error {error_response.code}: ", ""
                ),
                data=error_response.data,
            )
        except Exception:
            pass

    # Check if it's a standard Exception
    if isinstance(error, Exception):
        return CustomError(code=CustomErrorCode.INTERNAL_ERROR, message=str(error))

    # Fallback for unknown errors
    return CustomError(
        code=CustomErrorCode.INTERNAL_ERROR,
        message="Unknown error",
        data={"error": str(error) if error is not None else None},
    )
