"""Tracing system for MCP Outlet Python implementation.

This module provides comprehensive tracing with exact same API as TypeScript version,
ensuring consistent tracing behavior across implementations.
"""

import time
from datetime import datetime
from typing import List, Dict, Any, Optional, Union
from app.helpers.schema import TraceSpan


class Tracer:
    """Tracer class that mirrors the TypeScript Tracer implementation."""

    def __init__(
        self,
        trace_id: str,
        parent: Optional[str] = None,
        additional_data: Optional[Dict[str, Any]] = None,
    ):
        self.spans: List[TraceSpan] = []
        self.trace_id = trace_id
        self.start_time = datetime.now()
        self.end_time: Optional[datetime] = None
        self.current_parent = parent
        self.trace_additional_data = additional_data

    def record_span(
        self,
        name: str,
        parent_seq: Optional[str] = None,
        additional_data: Optional[Dict[str, Any]] = None,
    ) -> TraceSpan:
        """Record a new span, ending the previous running span if exists."""

        # End previous span if exists
        if self.spans and self.spans[-1].status == "running":
            self._end_previous_span(self.spans[-1], False)

        span = TraceSpan(
            seq=name,
            parent_seq=parent_seq or self.current_parent,
            start_time=time.time() * 1000,  # Convert to milliseconds
            status="running",
            data=additional_data,
            is_valid=True,
        )

        self.spans.append(span)
        return span

    def merge_child_trace(
        self,
        base_seq: str,
        parent_seq: str,
        is_success: bool,
        child_trace: Union[Dict[str, Any], List[TraceSpan], Dict[str, Any]],
        additional_data: Optional[Dict[str, Any]] = None,
    ):
        """Merge child trace data into current trace."""

        status = "success" if is_success else "error"
        additional_data = additional_data or {}

        try:
            # Try to parse as dict with trace structure
            if isinstance(child_trace, dict):
                try:
                    # Check if it has trace structure
                    if "spans" in child_trace and isinstance(
                        child_trace["spans"], list
                    ):
                        self._merge_spans_array(
                            child_trace["spans"],
                            base_seq,
                            parent_seq,
                            status,
                            additional_data,
                        )
                        # Merge trace additional data
                        if "data" in child_trace:
                            self._merge_trace_data(child_trace["data"], additional_data)
                        return
                    else:
                        # Single span-like object
                        self._create_fallback_span(
                            child_trace, base_seq, parent_seq, status, additional_data
                        )
                        return
                except Exception:
                    pass

            # Try to handle as spans array
            if isinstance(child_trace, list):
                self._merge_spans_array(
                    child_trace, base_seq, parent_seq, status, additional_data
                )
                return

            # Fallback: create a single span for the invalid trace
            self._create_fallback_span(
                child_trace, base_seq, parent_seq, status, additional_data
            )

        except Exception as error:
            # Create error span for any parsing errors
            self._create_error_span(
                child_trace, base_seq, parent_seq, status, additional_data, str(error)
            )

    def _merge_spans_array(
        self,
        spans: List[Any],
        base_seq: str,
        parent_seq: str,
        status: str,
        additional_data: Dict[str, Any],
    ):
        """Merge an array of span data."""
        for span_data in spans:
            try:
                if isinstance(span_data, dict):
                    merged_span = TraceSpan(
                        seq=f"{base_seq}.{span_data.get('seq', 'unknown_span')}",
                        parent_seq=span_data.get("parent_seq") or parent_seq,
                        start_time=span_data.get("start_time", time.time() * 1000),
                        duration=span_data.get("duration"),
                        status=span_data.get("status") or status,
                        error=span_data.get("error"),
                        data={**additional_data, **(span_data.get("data") or {})},
                        is_valid=False,
                    )
                    self.spans.append(merged_span)
            except Exception:
                # Skip invalid span data
                continue

    def _merge_trace_data(
        self, trace_data: Dict[str, Any], additional_data: Dict[str, Any]
    ):
        """Merge trace additional data."""
        if not self.trace_additional_data:
            self.trace_additional_data = {}

        self.trace_additional_data.update(additional_data)

        # Handle child traces
        child_traces = self.trace_additional_data.get("child_traces", [])
        child_traces.append(trace_data)
        self.trace_additional_data["child_traces"] = child_traces

    def _create_fallback_span(
        self,
        child_trace: Any,
        base_seq: str,
        parent_seq: str,
        status: str,
        additional_data: Dict[str, Any],
    ):
        """Create a fallback span for invalid trace data."""
        trace_id = "unknown_span"
        if isinstance(child_trace, dict):
            trace_id = child_trace.get("trace_id") or child_trace.get("seq") or trace_id

        span = TraceSpan(
            seq=f"{base_seq}.{trace_id}",
            parent_seq=parent_seq,
            start_time=time.time() * 1000,
            status=status,
            duration=0,
            data={**additional_data, "child_trace": child_trace},
            is_valid=False,
        )
        self.spans.append(span)

    def _create_error_span(
        self,
        child_trace: Any,
        base_seq: str,
        parent_seq: str,
        status: str,
        additional_data: Dict[str, Any],
        error_message: str,
    ):
        """Create an error span for parsing failures."""
        trace_id = "parse_error"
        if isinstance(child_trace, dict):
            trace_id = child_trace.get("seq") or child_trace.get("trace_id") or trace_id

        span = TraceSpan(
            seq=f"{base_seq}.{trace_id}",
            parent_seq=parent_seq,
            start_time=time.time() * 1000,
            status=status,
            duration=0,
            error=error_message,
            data={**additional_data, "child_trace": child_trace},
            is_valid=False,
        )
        self.spans.append(span)

    def _end_previous_span(self, span: TraceSpan, is_error: bool):
        """End a span by calculating duration and setting status."""
        end_time = time.time() * 1000
        span.duration = end_time - span.start_time
        span.status = "error" if is_error else "success"

    def _end(self):
        """End the trace by setting end time."""
        if not self.end_time:
            self.end_time = datetime.now()

    def get_trace(self, last_span_success: bool = True) -> Dict[str, Any]:
        """Get the final trace with all spans completed."""

        # End any running spans
        for span in self.spans:
            if span.status == "running":
                self._end_previous_span(span, not last_span_success)

        # Convert spans to output format (ensuring all fields are present)
        output_spans = []
        for span in self.spans:
            output_span = {
                "seq": span.seq,
                "parentSeq": span.parent_seq,
                "startTime": span.start_time,
                "duration": span.duration,
                "status": span.status,
                "error": span.error,
                "data": span.data,
                "isValid": span.is_valid,
            }
            output_spans.append(output_span)

        self._end()

        return {
            "traceId": self.trace_id,
            "startTime": self.start_time.isoformat() if self.start_time else None,
            "endTime": self.end_time.isoformat() if self.end_time else None,
            "data": self.trace_additional_data,
            "spans": output_spans,
            "isValid": True,
        }
