"""Schema definitions for MCP Outlet Python implementation.

This module provides Pydantic schemas that mirror the Zod schemas
in the TypeScript implementation, ensuring exact same input/output structure.
"""

from typing import Dict, Any, Optional, List, Union, Literal
from pydantic import BaseModel, Field, ConfigDict
from datetime import datetime


class McpServerConfiguration(BaseModel):
    """MCP Server Configuration schema (stdio only)."""

    protocol_version: str = Field(
        default="2025-03-26", description="Protocol version", alias="protocolVersion"
    )
    jsonrpc: Literal["2.0"] = Field(default="2.0", description="JSON-RPC version")
    type: Literal["stdio"] = Field(default="stdio")
    command: str = Field(description="Command to execute (stdio only)")
    args: Optional[List[str]] = Field(
        default=None, description="Command arguments (stdio only)"
    )
    cwd: Optional[str] = Field(
        default=None, description="Working directory (stdio only)"
    )
    stderr: Optional[Union[str, int]] = Field(
        default=None,
        description="How to handle stderr of the child process (stdio only)",
    )
    env: Optional[Dict[str, str]] = Field(
        default=None, description="Environment variables"
    )
    version: Optional[str] = Field(
        default=None, description="Version of the MCP server"
    )

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    def model_dump(self, **kwargs) -> Dict[str, Any]:
        """Override model_dump to ensure protocolVersion is used instead of protocol_version."""
        data = super().model_dump(by_alias=True, **kwargs)
        return data


class McpCallerConfiguration(BaseModel):
    """MCP Server Configuration schema (stdio only)."""

    protocol_version: str = Field(
        default="2025-03-26", description="Protocol version", alias="protocolVersion"
    )
    jsonrpc: Literal["2.0"] = Field(default="2.0", description="JSON-RPC version")
    type: Literal["stdio"] = Field(default="stdio")
    args: Optional[List[str]] = Field(
        default=None, description="Command arguments (stdio only)"
    )
    module_path: str = Field(description="Module path")
    package_name: str = Field(description="Module name")
    function_name: str = Field(description="Function name")

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    def model_dump(self, **kwargs) -> Dict[str, Any]:
        """Override model_dump to ensure protocolVersion is used instead of protocol_version."""
        data = super().model_dump(by_alias=True, **kwargs)
        return data


class CustomRequestMeta(BaseModel):
    """Request metadata schema."""

    server: McpServerConfiguration

    model_config = ConfigDict(extra="allow", populate_by_name=True)


class TraceSpan(BaseModel):
    """Trace span schema."""

    seq: str = Field(description="Sequential identifier or name of the span operation")
    parent_seq: Optional[str] = Field(
        default=None,
        description="Sequential identifier of the parent span, null for root spans",
        alias="parentSeq",
    )
    start_time: float = Field(
        description="Start timestamp in milliseconds since Unix epoch",
        alias="startTime",
    )
    duration: Optional[float] = Field(
        default=None, description="Duration of the span in milliseconds"
    )
    status: Literal["running", "success", "error"] = Field(
        description="Current status of the span execution"
    )
    error: Optional[str] = Field(
        default=None, description="Error message if the span failed"
    )
    data: Optional[Dict[str, Any]] = Field(
        default=None, description="Additional custom data attached to the span"
    )
    is_valid: bool = Field(
        description="Whether the span data is valid according to schema",
        alias="isValid",
    )

    model_config = ConfigDict(populate_by_name=True)


class Trace(BaseModel):
    """Trace schema."""

    trace_id: str = Field(
        description="Unique identifier for the entire trace", alias="traceId"
    )
    start_time: datetime = Field(
        description="Start time of the trace as a DateTime object", alias="startTime"
    )
    end_time: Optional[datetime] = Field(
        default=None,
        description="End time of the trace as a DateTime object",
        alias="endTime",
    )
    data: Optional[Dict[str, Any]] = Field(
        default=None, description="Additional custom data attached to the trace"
    )
    spans: List[TraceSpan] = Field(
        description="Array of all spans that occurred during this trace"
    )
    is_valid: bool = Field(
        description="Whether the trace data is valid according to schema",
        alias="isValid",
    )

    model_config = ConfigDict(populate_by_name=True)


class CustomErrorResponse(BaseModel):
    """Custom error response schema."""

    code: int
    message: str
    data: Optional[Dict[str, Any]] = None


# Supported protocol versions (mirrors TypeScript constants)
SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05", "2024-10-07"]
LATEST_PROTOCOL_VERSION = "2025-03-26"
