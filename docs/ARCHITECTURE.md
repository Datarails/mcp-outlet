# MCP Outlet – Architecture Deep Dive

This document explains the internals of MCP Outlet in more detail than the top-level README.

## 1. High-Level Overview

```
Client → Azure Function (Python 3.11) → MCP Outlet RPC handler → MCP Server (stdin/stdout)
```

- The Azure Function receives JSON-RPC 2.0 requests.
- The single entry-point `rpc.py` validates input, routes the method, and either handles it directly or forwards it to an MCP server via a lightweight **stdio** transport.
- Responses are wrapped with tracing metadata and returned to the client.

## 2. Project Layout

```
├── src/
│   ├── python/app/           # Production runtime
│   │   ├── handlers/
│   │   │   └── rpc.py        # <— single entry point
│   │   └── helpers/          # Tracer, error, schema, mcp_caller …
│   └── js/                   # Reference TypeScript port (not prod)
├── deployments/
│   └── azure/                # Deployment assets & scripts
└── docs/                     # Documentation (you are here)
```

## 3. Request Lifecycle

1. **Validation** – Pydantic schemas check JSON-RPC envelope and `_meta.server` config.
2. **Routing** – `handlers_map` decides:
   - function ⇒ handled inside `rpc.py` (e.g., `ping`)
   - `True` ⇒ proxied to MCP server (`initialize`, `tools/list`, …)
   - `False` ⇒ error (unsupported)
3. **Forwarding** – `McpCaller` spins up (or re-uses) the MCP server process via stdio, writes the request, and awaits the response.
4. **Tracing** – `Tracer` creates nested spans for each significant step; stdout/stderr are streamed into trace events.
5. **Cleanup** – Connections are closed and the outer span is finished.

## 4. Concurrency Model

Python runs in an Azure Functions multi-threaded worker. To avoid race conditions:

```python
import asyncio
_rpc_lock = asyncio.Lock()

async with _rpc_lock:
    await handle_request()
```

JavaScript (experimental implementation) relies on Node's single-threaded event loop and therefore needs no explicit locks.

## 5. Performance Techniques

- **Pre-imports** heavy libs (`numpy`, `pandas`, etc.) so the warm path skips import time.
- **UV package manager** installs any missing wheel into a shared cache within <50 ms.
- **OS pipes + threads** instead of `subprocess.Popen` for MCP servers.
- **Selective JSON serialisation** – helper skips `None` values to reduce payload size.

Empirically this yields <500 ms average latency on warm executions (EP1 plan).

## 6. Adding New Methods

1. Open `src/python/app/handlers/rpc.py`.
2. Add your method to `handlers_map`:

```python
handlers_map["resources/templates/read"] = True  # proxy to server
```

3. (Optional) Mirror in `src/js/handlers/rpc.ts`.
4. Update tests in `test/config.ts` if needed.

## 7. Testing Strategy

A single TypeScript config defines test cases; it is serialised to JSON and consumed by both Jest (TS) and Pytest. Mocks are activated in Python only when a test specifies them.

## 8. Deployment Flow

The **Azure** deploy script (`npm run deploy`) performs:

1. Bundles the Python function and UV layer.
2. Creates or updates an Azure Function App via Azure CLI.
3. Uploads the zipped artefacts.

Future providers (AWS, GCP) share the same config format but are not yet production-ready.

---

For day-to-day development tips see `docs/DEVELOPMENT.md` (coming soon).
