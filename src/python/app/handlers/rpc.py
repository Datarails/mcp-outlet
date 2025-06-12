"""RPC handler for MCP Outlet Python implementation.

This module provides the main RPC handler that mirrors the TypeScript implementation,
handling JSON-RPC requests and routing them appropriately.
"""

from typing import Any, Dict, Optional
from pydantic import ValidationError

# Absolute imports from python package
from app.helpers.tracer import Tracer
from app.helpers.error import CustomError, format_error, CustomErrorCode
from app.helpers.schema import CustomRequestMeta, McpCallerConfiguration
from app.helpers.mcp_caller import McpCaller
from app.helpers.uv_handler import parse_mcp_server_params
from app.handlers.helpers import HandlerInput, RuntimeContext, get_trace_id

# import common and heavy dependencies for keeping runtime fast
import pandas
import requests
import numpy
import matplotlib.pyplot
import time

# Concurrency lock to ensure only one RPC call is processed at a time on this machine
import asyncio

# Module-level asyncio lock used to serialise access to the rpc_handler
_rpc_lock = asyncio.Lock()


def generate_jsonrpc_response(
    data: Optional[Dict[str, Any]] = None,
    tracer: Optional[Tracer] = None,
    result: Optional[Dict[str, Any]] = None,
    error: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Generate JSON-RPC response that mirrors the TypeScript generateJSONRPCResponse function."""

    # Parse _meta from data params
    parsed_success = False
    server_config = None

    try:
        if data and data.get("params") and data["params"].get("_meta"):
            meta = CustomRequestMeta(**data["params"]["_meta"])
            parsed_success = True
            server_config = meta.server.model_dump()
    except (ValidationError, TypeError, KeyError):
        pass

    # Build custom metadata
    custom_metadata = {}
    if parsed_success and server_config:
        custom_metadata["server"] = server_config
    if tracer:
        custom_metadata["trace"] = tracer.get_trace(error is None)

    # Handle error response
    if error:
        response = {
            "jsonrpc": data.get("jsonrpc", "2.0") if data else "2.0",
            "error": {
                **error,
                "data": {
                    **(
                        error.get("data", {})
                        if isinstance(error.get("data"), dict)
                        else {}
                    ),
                    "_meta": {
                        **custom_metadata,
                        **(
                            error.get("data", {}).get("_meta", {})
                            if isinstance(error.get("data"), dict)
                            and isinstance(error.get("data", {}).get("_meta"), dict)
                            else {}
                        ),
                    },
                },
            },
        }

        # Add id if present in request data
        if data and "id" in data:
            response["id"] = data["id"]

        return response

    # Handle success response
    response = {
        "jsonrpc": data.get("jsonrpc", "2.0") if data else "2.0",
        "result": {
            **(result or {}),
            "_meta": {
                **(
                    result.get("_meta", {})
                    if result and isinstance(result.get("_meta"), dict)
                    else {}
                ),
                **custom_metadata,
            },
        },
    }

    # Add id if present in request data
    if data and "id" in data:
        response["id"] = data["id"]

    return response


# Handler map that mirrors the JavaScript handlersMap
handlers_map = {
    # Outlet-level methods (handled directly)
    "ping": lambda params, _: {"result": None},
    "logging/setLevel": lambda params, _: {
        "result": {
            "_meta": {"traceLevel": params.get("params", {}).get("level", "info")}
        }
    },
    "notifications/initialized": lambda params, _: {"result": None},
    # MCP server-level methods (forwarded to MCP server)
    "initialize": True,
    "prompts/get": True,
    "prompts/list": True,
    "resources/list": True,
    "resources/templates/list": True,
    "resources/read": True,
    "tools/call": True,
    "tools/list": True,
    "completion/complete": True,
    # Unsupported methods
    "notifications/roots/list_changed": False,
    "resources/unsubscribe": False,
    "resources/subscribe": False,
    "sampling/createMessage": False,
    "roots/list": False,
}


async def rpc_handler(
    handler_input: HandlerInput, context: RuntimeContext
) -> Dict[str, Any]:
    """RPC handler that mirrors the TypeScript rpc handler."""

    # Ensure single-threaded execution by acquiring the global lock
    await _rpc_lock.acquire()

    tracer = Tracer(get_trace_id(handler_input.data, "id"))
    mcp_caller = None

    try:
        # AWS-specific handling
        if "callbackWaitsForEmptyEventLoop" in context:
            context["callbackWaitsForEmptyEventLoop"] = True

        tracer.record_span("inputValidation")

        # Validate _meta parameters
        try:
            request_data = handler_input.data

            if (
                not request_data
                or not request_data.get("params")
                or not request_data["params"].get("_meta")
            ):
                raise CustomError(
                    CustomErrorCode.INVALID_REQUEST,
                    "Request _meta must be including correct server configuration",
                    {"reason": "Missing _meta in params"},
                )

            meta_params = CustomRequestMeta(**request_data["params"]["_meta"])
        except ValidationError as e:
            raise CustomError(
                CustomErrorCode.INVALID_REQUEST,
                "Request _meta must be including correct server configuration",
                {"reason": str(e)},
            )

        # Get method and check if it's supported
        method = request_data.get("method", "")
        handler = handlers_map.get(method)

        if handler is None:
            supported_methods = [
                key for key, value in handlers_map.items() if value is not False
            ]
            raise CustomError(
                CustomErrorCode.METHOD_NOT_FOUND,
                f"Rpc supporting only {', '.join(supported_methods)} methods",
            )

        # Handle outlet-level methods (functions)
        if callable(handler):
            tracer.record_span("outletHandler")
            result = handler(request_data, context)
            return generate_jsonrpc_response(request_data, tracer, result.get("result"))

        # Handle unsupported methods
        if handler is False:
            supported_methods = [
                key for key, value in handlers_map.items() if value is not False
            ]
            raise CustomError(
                CustomErrorCode.METHOD_NOT_FOUND,
                f"Rpc supporting only {', '.join(supported_methods)} methods",
            )

        # Handle MCP server-level methods (handler is True)
        if handler is True:
            # For notifications, can't work with server handler
            if "id" not in request_data:
                raise CustomError(
                    CustomErrorCode.METHOD_NOT_FOUND, f"Method not found: {method}"
                )
            tracer.record_span("extractingServerConfig")
            if meta_params.server.command.startswith("uv"):
                uv_params = parse_mcp_server_params(meta_params.server.args)
            else:
                raise CustomError(
                    CustomErrorCode.INVALID_REQUEST,
                    "Only uv or uvx command is supported for now",
                )
            tracer.record_span("connectToServer")
            mcp_caller = McpCaller(
                McpCallerConfiguration(
                    jsonrpc=meta_params.server.jsonrpc,
                    protocol_version=meta_params.server.protocol_version,
                    type=meta_params.server.type,
                    args=meta_params.server.args,
                    module_path=uv_params.get("module_path"),
                    package_name=uv_params.get("package_name"),
                    function_name=uv_params.get("function_name"),
                )
            )
            await mcp_caller.connect()

            tracer.record_span("executeMcpCall", None, {"method": method})
            result = await mcp_caller.execute_mcp_call(request_data, tracer)

            # Return the result from MCP call directly
            return generate_jsonrpc_response(request_data, tracer, result)

    except CustomError as e:
        return generate_jsonrpc_response(
            (
                request_data
                if "request_data" in locals()
                else handler_input.data.get("data") if handler_input.data else None
            ),
            tracer,
            None,
            e.to_response(),
        )
    except Exception as e:
        formatted_error = format_error(e)
        return generate_jsonrpc_response(
            (
                request_data
                if "request_data" in locals()
                else handler_input.data.get("data") if handler_input.data else None
            ),
            tracer,
            None,
            formatted_error.to_response(),
        )
    finally:
        # Always release the lock and close the MCP caller if needed
        if mcp_caller:
            await mcp_caller.close()

        _rpc_lock.release()


class RPCHandler:
    """Main RPC handler that mirrors the TypeScript rpc handler."""

    def __init__(self):
        self.name = "rpc"

    async def execute(
        self, handler_input: HandlerInput, context: RuntimeContext
    ) -> Any:
        """Execute RPC request - mirrors TypeScript rpc.execute method."""
        return await rpc_handler(handler_input, context)


# Global RPC handler instance
rpc = RPCHandler()
