"""MCP Caller for Python implementation.

This module provides the MCP caller interface for connecting to and executing
calls against MCP servers using a simple threading approach.
"""

import asyncio
import json
import threading
import importlib
import sys
import os
from io import StringIO
from typing import Any, Dict, List, Optional, Union

# Absolute imports from python package
from app.helpers.error import CustomError, CustomErrorCode, format_error
from app.helpers.schema import McpCallerConfiguration
from app.helpers.tracer import Tracer


def _convert_to_dict(obj: Any) -> Any:
    """Convert objects to JSON-serializable dictionaries."""
    if obj is None:
        return None
    elif isinstance(obj, (str, int, float, bool)):
        return obj
    elif isinstance(obj, (list, tuple)):
        return [_convert_to_dict(item) for item in obj]
    elif isinstance(obj, dict):
        # Skip None values to match TypeScript behavior
        result = {}
        for key, value in obj.items():
            converted_value = _convert_to_dict(value)
            if converted_value is not None:
                result[key] = converted_value
        return result
    elif hasattr(obj, "model_dump"):
        # Pydantic models - exclude None values
        return obj.model_dump(exclude_none=True)
    elif hasattr(obj, "__dict__"):
        # Regular objects - convert attributes to dict, skip None values
        result = {}
        for key, value in obj.__dict__.items():
            if not key.startswith("_"):  # Skip private attributes
                converted_value = _convert_to_dict(value)
                if converted_value is not None:
                    result[key] = converted_value
        return result
    else:
        # For other types, try to convert to string or return as-is
        try:
            return str(obj)
        except Exception:
            return None


class SimpleThreadedMcpServer:
    """Threaded MCP server using real OS pipes for communication."""

    def __init__(self, module_path: str, function_name: str = "main"):
        self.module_path = module_path
        self.function_name = function_name
        self.server_thread = None
        self.is_running = False
        self.shutdown_flag = threading.Event()

        # Create real OS pipes for stdin/stdout communication
        self.stdin_read_fd, self.stdin_write_fd = os.pipe()
        self.stdout_read_fd, self.stdout_write_fd = os.pipe()

        # Convert to file objects
        self.stdin_read_file = os.fdopen(self.stdin_read_fd, "r")
        self.stdin_write_file = os.fdopen(self.stdin_write_fd, "w")
        self.stdout_read_file = os.fdopen(self.stdout_read_fd, "r")
        self.stdout_write_file = os.fdopen(self.stdout_write_fd, "w")

    def start(self):
        """Start the MCP server in a thread."""
        if self.is_running:
            return

        self.server_thread = threading.Thread(target=self._run_server, daemon=True)
        self.server_thread.start()
        self.is_running = True

    def stop(self):
        """Stop the MCP server thread."""
        self.shutdown_flag.set()
        self.is_running = False

        # Close write end to signal EOF to server
        try:
            self.stdin_write_file.close()
        except:
            pass

        if self.server_thread:
            self.server_thread.join(timeout=2.0)

        # Clean up remaining file descriptors
        try:
            self.stdin_read_file.close()
            self.stdout_read_file.close()
            self.stdout_write_file.close()
        except:
            pass

    def send_request(
        self, request: Dict[str, Any], timeout: float = 30.0
    ) -> Dict[str, Any]:
        """Send request to server and get response."""
        if not self.is_running:
            raise RuntimeError("Server not running")

        try:
            # Send request through the pipe
            json_data = json.dumps(request) + "\n"
            self.stdin_write_file.write(json_data)
            self.stdin_write_file.flush()

            # Read response with timeout
            import select

            ready, _, _ = select.select([self.stdout_read_file], [], [], timeout)
            if not ready:
                raise TimeoutError(f"Request timed out after {timeout} seconds")

            response_line = self.stdout_read_file.readline()
            if not response_line:
                raise RuntimeError("No response from MCP server")

            return json.loads(response_line.strip())
        except Exception:
            raise

    def _run_server(self):
        """Run the MCP server in thread with real pipe-based I/O."""
        try:
            module = importlib.import_module(self.module_path)
            main_func = getattr(module, self.function_name)

            # Replace sys.stdin/stdout with our pipe file objects
            old_stdin, old_stdout, old_stderr = sys.stdin, sys.stdout, sys.stderr
            try:
                # Use the read end for stdin (server reads from this)
                # Use the write end for stdout (server writes to this)
                sys.stdin = self.stdin_read_file
                sys.stdout = self.stdout_write_file

                # Create new event loop for this thread
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)

                try:
                    if main_func:
                        # Check if main_func is async
                        import inspect

                        if inspect.iscoroutinefunction(main_func):
                            loop.run_until_complete(main_func())
                        else:
                            # Sync main function - run it directly
                            main_func()
                    else:
                        raise ValueError(
                            f"No suitable function found in {self.module_path}"
                        )

                except Exception:
                    import traceback

                    traceback.print_exc(file=sys.stderr)
                    raise
                finally:
                    loop.close()

            finally:
                sys.stdin, sys.stdout, sys.stderr = old_stdin, old_stdout, old_stderr

        except Exception as e:
            import traceback

            traceback.print_exc(file=sys.stderr)

            # Send error response through stdout pipe
            error_response = {
                "jsonrpc": "2.0",
                "error": {"code": -32603, "message": f"Server error: {str(e)}"},
            }
            try:
                self.stdout_write_file.write(json.dumps(error_response) + "\n")
                self.stdout_write_file.flush()
            except:
                pass


class McpCaller:
    """MCP Caller for managing connections and executing calls to MCP servers."""

    def __init__(self, config: McpCallerConfiguration):
        """Initialize the MCP caller with server configuration."""
        self.config = config
        self._request_message_id = 1
        self._is_connected = False
        self.server_info: Optional[Dict[str, Any]] = None
        self._server = None

    async def connect(self) -> Dict[str, Any]:
        """Connect to the MCP server.

        Returns:
            InitializeResult from the server's initialize response
        """
        if self._is_connected and self.server_info:
            return self.server_info

        try:
            # Start the threaded server
            self._server = SimpleThreadedMcpServer(
                self.config.module_path, self.config.function_name
            )
            self._server.start()

            # Give the server a moment to start up
            await asyncio.sleep(0.001)

            # Initialize the connection
            init_request = {
                "jsonrpc": self.config.jsonrpc,
                "id": self._request_message_id,
                "method": "initialize",
                "params": {
                    "protocolVersion": self.config.protocol_version,
                    "capabilities": {},
                    "clientInfo": {
                        "name": "mcp-outlet-python",
                        "version": "1.0.0",
                    },
                },
            }
            self._request_message_id += 1

            # Send initialize request with shorter timeout since server should respond quickly
            loop = asyncio.get_event_loop()
            init_response = await loop.run_in_executor(
                None, self._server.send_request, init_request, 30.0
            )

            if "error" in init_response:
                raise CustomError(
                    CustomErrorCode.INTERNAL_ERROR,
                    f"Initialize failed: {init_response['error']['message']}",
                )

            self.server_info = init_response.get("result", {})

            # Send initialized notification
            initialized_request = {
                "jsonrpc": self.config.jsonrpc,
                "method": "notifications/initialized",
                "params": {},
            }

            # For notifications, we don't wait for response
            try:
                await loop.run_in_executor(
                    None, self._server.send_request, initialized_request, 0.00001
                )
            except:
                pass  # Notifications might not return anything

            self._is_connected = True
            return self.server_info

        except Exception as e:
            if self._server:
                self._server.stop()
                self._server = None
            raise format_error(e)

    async def close(self) -> None:
        """Close the connection to the MCP server."""
        if self._server:
            self._server.stop()
            self._server = None

        self._is_connected = False
        self.server_info = None

    async def execute_mcp_call(
        self, input_request: Dict[str, Any], tracer: Optional[Tracer] = None
    ) -> Union[Dict[str, Any], Any]:
        """Execute an MCP call against the connected server.

        Args:
            input_request: JSON-RPC request to send to the MCP server
            tracer: Optional tracer instance for operation tracking

        Returns:
            Response from the MCP server
        """
        # Ensure we're connected
        if not self._is_connected or not self._server:
            raise CustomError(CustomErrorCode.CONNECTION_CLOSED, "Not connected")

        # Handle initialize method specially
        if input_request.get("method") == "initialize":
            if self.server_info:
                return _convert_to_dict(self.server_info)
            else:
                raise CustomError(
                    CustomErrorCode.INVALID_REQUEST, "Please connect first"
                )

        captured_logs: List[str] = []

        # Store original console methods and set up capture
        original_stdout = sys.stdout
        original_stderr = sys.stderr
        stdout_capture = StringIO()
        stderr_capture = StringIO()

        def safe_capture(level: str, content: str) -> None:
            try:
                if content.strip():
                    captured_logs.append(f"[{level}] {content.strip()}")
            except Exception:
                pass

        try:
            # Set up console capture
            sys.stdout = stdout_capture
            sys.stderr = stderr_capture

            # Assign message ID if not present
            if "id" not in input_request:
                input_request["id"] = self._request_message_id
                self._request_message_id += 1

            # Send request to threaded server
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None, self._server.send_request, input_request, 30.0
            )

            # Capture any output
            stdout_content = stdout_capture.getvalue()
            stderr_content = stderr_capture.getvalue()

            if stdout_content:
                safe_capture("LOG", stdout_content)
            if stderr_content:
                safe_capture("ERROR", stderr_content)

            # Handle response
            if "error" in response:
                error_data = response["error"]
                raise CustomError(
                    CustomErrorCode.INTERNAL_ERROR,
                    error_data.get("message", "MCP server error"),
                    error_data,
                )

            # Handle tracing for successful response
            if tracer:
                tracer.merge_child_trace(
                    "executeMcpCall",
                    "executeMcpCall",
                    True,
                    [],
                    {"logs": captured_logs} if captured_logs else {},
                )

            # Return just the result data
            return _convert_to_dict(response.get("result"))

        except Exception as error:
            # Capture any output from error case
            stdout_content = stdout_capture.getvalue()
            stderr_content = stderr_capture.getvalue()

            if stdout_content:
                safe_capture("LOG", stdout_content)
            if stderr_content:
                safe_capture("ERROR", stderr_content)

            # Handle tracing for error response
            if tracer:
                tracer.merge_child_trace(
                    "mcpCall.server",
                    "mcpCall",
                    False,
                    [],
                    {"logs": captured_logs} if captured_logs else {},
                )
            raise error
        finally:
            # Restore console
            sys.stdout = original_stdout
            sys.stderr = original_stderr
