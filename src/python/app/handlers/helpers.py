"""Handler helpers for MCP Outlet Python implementation.

This module provides handler types and utilities that mirror the TypeScript implementation,
ensuring consistent handler patterns across platforms.
"""

import uuid
from typing import Dict, Any, Optional, Callable, Awaitable
from pydantic import BaseModel
from dataclasses import dataclass


@dataclass
class HandlerInput:
    """Handler input structure that mirrors TypeScript HandlerInput<T>."""

    data: Any
    headers: Dict[str, str]
    path_params: Dict[str, str]
    query_params: Dict[str, str]


@dataclass
class HandlerConfiguration:
    """Handler configuration structure that mirrors TypeScript HandlerConfiguration<T>."""

    name: str
    input_schema: BaseModel
    output_schema: BaseModel
    execute: Callable[[HandlerInput, Dict[str, Any]], Awaitable[Any]]


# Runtime context type alias
RuntimeContext = Dict[str, Any]


def get_trace_id(args: Dict[str, Any], trace_path: Optional[str] = None) -> str:
    """Get trace ID from args or generate a new one, mirroring TypeScript getTraceId."""

    if trace_path:
        try:
            trace_value = args.get(trace_path)
            if trace_value is not None:
                return str(trace_value)
        except Exception:
            # Do nothing, fall through to generate new UUID
            pass

    return str(uuid.uuid4())
