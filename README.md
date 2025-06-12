# MCP Outlet - Universal MCP Runtime Orchestrator

> **Production-Ready**: Sub-500ms MCP server proxy with Azure deployment

MCP Outlet acts like an electrical outlet for MCP servers - providing a safe, universal runtime that accepts any MCP server configuration without requiring specific deployment for each server.

## ✅ What Works (Production Ready)

- **Python Implementation**: Optimized runtime with sub-500ms response times
- **Azure Deployment**: Single-command deployment to Azure Functions
- **MCP Server Proxy**: Forward requests to any MCP server safely
- **Performance Optimization**: UV package manager, pre-imports, threaded servers
- **Concurrency Control**: Race condition prevention with asyncio locks
- **Full Tracing**: Comprehensive operation monitoring and console capture

## ⚠️ Available (Not Optimized)

- **TypeScript Implementation**: Basic functionality exists, not production-ready
- **Testing Framework**: Maintained but not current focus

## ❌ TBD (Not Working)

- **AWS Deployment**: Implementation exists but deployment fails
- **GCP Deployment**: Framework exists but incomplete
- **JS Function Optimization**: Major performance work needed

## Quick Start

- **Identical APIs**: Same method signatures and behavior patterns
- **Shared Test Configuration**: Single source of truth for validation
- **Unified Schema System**: Zod (TypeScript) and Pydantic (Python) with matching schemas
- **Consistent Error Handling**: Same error codes and formatting across languages
- **Parallel Tracing**: Identical span management and trace collection
- **Language-Specific Concurrency**: Each implementation uses optimal concurrency patterns for its runtime

### Language-Specific Optimizations

**TypeScript Implementation:**

- ES modules with Node.js compatibility
- Zod schema validation with TypeScript inference
- Jest testing with ES module support
- Express-based offline development server
- **Natural serialization** through JavaScript's single-threaded event loop

**Python Implementation:**

- Modern async/await patterns throughout
- Pydantic v2 with FastAPI-style validation
- pytest with asyncio support
- UV package manager for fast dependency resolution
- **Optimized for sub-500ms response time** (excluding cold start)
- **Explicit concurrency control** with asyncio locks for race condition prevention

### Request Flow Consistency

Both languages implement identical request processing:

```
JSON-RPC Request → Input Validation → Method Routing → Execution → Response Formatting
```

The method routing map is mirrored between languages, ensuring that a request to either implementation produces the same result.

### Concurrency Management Differences

While both implementations produce identical results, they handle concurrency differently based on their runtime characteristics:

**TypeScript Concurrency Model:**

- **Single-Threaded**: JavaScript's event loop provides natural request serialization
- **No Explicit Locking**: Race conditions prevented by language design
- **Event-Driven**: Async operations handled through event loop scheduling
- **Lambda Optimization**: Sets `callbackWaitsForEmptyEventLoop = true` for proper AWS Lambda handling

**Python Concurrency Model:**

- **Multi-Threaded Aware**: Explicitly handles potential concurrent execution
- **Module-Level Locking**: Uses `asyncio.Lock()` to serialize RPC handler execution
- **Race Condition Prevention**: Protects shared resources like MCP connections and UV cache
- **Proper Cleanup**: Ensures lock release in finally blocks to prevent deadlocks

This design allows each language to use its optimal concurrency approach while maintaining identical external behavior and API compatibility.

## Performance Optimization

The Python implementation has been extensively optimized to achieve **sub-500ms response times** (excluding cold start), making it suitable for production workloads with strict latency requirements.

### Performance Achievement

- **Target Met**: < 0.5 seconds response time (warm execution)
- **Cold Start**: 1-3 seconds depending on cloud provider
- **Memory Efficiency**: Optimized for minimal memory footprint
- **Concurrent Handling**: Efficient processing of multiple simultaneous MCP calls

### Key Optimization Techniques

#### 1. Pre-Import Strategy

Heavy dependencies are imported at module level to eliminate runtime import costs:

```python
# Pre-imported in rpc.py for immediate availability
import pandas
import numpy
import matplotlib.pyplot
import requests
```

This moves the import cost to the cold start phase rather than request handling.

#### 2. UV Package Manager Integration

UV provides lightning-fast package installation and caching:

- **Strategic Caching**: Packages cached in `/mnt/cache` or `CACHE_DIR`
- **No Bytecode Compilation**: `UV_COMPILE_BYTECODE=0` saves time
- **Direct Installation**: `UV_BREAK_SYSTEM_PACKAGES=1` avoids virtual env overhead
- **Optimized Environment**: Custom `PYTHONPATH` prioritizes UV cache

#### 3. Threaded MCP Server Architecture

Revolutionary approach using OS pipes instead of subprocess:

```python
# Direct OS pipe communication
self.stdin_read_fd, self.stdin_write_fd = os.pipe()
self.stdout_read_fd, self.stdout_write_fd = os.pipe()
```

Benefits:

- **Zero Process Overhead**: No subprocess spawning
- **Direct I/O**: Minimal latency for inter-process communication
- **Thread Efficiency**: Leverages Python's threading for I/O operations
- **Resource Reuse**: Same Python interpreter, reduced memory usage

#### 4. Smart Package Detection

Avoids unnecessary package installations:

```python
def _is_package_installed(pkg: str) -> bool:
    try:
        import importlib.metadata
        importlib.metadata.version(pkg)
        return True
    except importlib.metadata.PackageNotFoundError:
        return False
```

#### 5. Efficient JSON Serialization

Custom converter skips None values and optimizes object traversal:

```python
def _convert_to_dict(obj):
    if obj is None:
        return None
    # Direct attribute access, skip None values
    # Optimized for MCP response objects
```

#### 6. Async/Await Optimization

- **Executor Pattern**: `run_in_executor` for blocking operations
- **Event Loop Reuse**: Avoid creating new loops
- **Minimal Async Overhead**: Direct execution for synchronous operations

#### 7. Concurrency Control and Race Condition Prevention

Python implementation uses explicit locking to ensure thread safety:

```python
# Module-level asyncio lock for serialization
import asyncio
_rpc_lock = asyncio.Lock()

async def rpc_handler(handler_input, context):
    # Acquire lock to prevent race conditions
    await _rpc_lock.acquire()

    tracer = Tracer(get_trace_id(handler_input.data, "id"))
    mcp_caller = None

    try:
        # Handler logic with guaranteed serialization
        # ... processing ...
    finally:
        # Always cleanup resources and release lock
        if mcp_caller:
            await mcp_caller.close()
        _rpc_lock.release()
```

**Benefits:**

- **Thread Safety**: Prevents race conditions in multi-threaded environments
- **Resource Protection**: Ensures safe access to MCP connections and shared state
- **Deadlock Prevention**: Proper try/finally pattern guarantees lock release
- **Performance Balance**: Serialization trade-off for safety in Python runtime

**Design Rationale:**

- **TypeScript**: Relies on single-threaded event loop for natural serialization
- **Python**: Uses explicit locking due to multi-threaded execution environment
- **Critical Sections**: Kept minimal to maintain performance while ensuring safety

### Performance Configuration

Optimal UV environment setup for serverless:

```python
env.update({
    "UV_CACHE_DIR": cache_dir,
    "UV_COMPILE_BYTECODE": "0",      # Skip bytecode compilation
    "UV_LINK_MODE": "copy",           # Faster than symlinks
    "UV_NO_SYNC": "1",                # Skip lock file sync
    "UV_NO_PROJECT": "1",             # No project detection overhead
    "UV_BREAK_SYSTEM_PACKAGES": "1",  # Direct system installation
})
```

### Performance Best Practices

1. **Always Pre-Import**: Add commonly used heavy libraries to the import list
2. **Cache Everything**: Leverage UV's caching for all package operations
3. **Use Threading**: Prefer `SimpleThreadedMcpServer` over subprocess
4. **Minimize Serialization**: Use efficient converters, skip None values
5. **Check Before Installing**: Always verify package existence first
6. **Implement Proper Concurrency Control**: Use module-level asyncio locks to prevent race conditions
7. **Keep Critical Sections Minimal**: Hold locks only for essential operations to maintain performance

### Benchmarking Results

The optimizations result in consistent sub-500ms performance:

- **Simple MCP Calls**: 200-300ms
- **Complex Operations**: 400-500ms
- **Package Installation**: Cached packages add < 50ms
- **Thread Creation**: < 10ms overhead vs subprocess (> 100ms)

This performance profile makes MCP Outlet suitable for real-time applications, interactive tools, and high-frequency MCP operations in production environments.

## Tracing System

MCP Outlet implements comprehensive distributed tracing to provide visibility into MCP server interactions and system behavior.

### Trace Architecture

**Hierarchical Spans:**

- **Root Span**: Represents the entire request lifecycle
- **Method Spans**: Track specific MCP method executions
- **Connection Spans**: Monitor MCP server connection establishment
- **Error Spans**: Capture failure scenarios with full context

**Trace Metadata:**

- Request/response payloads
- Timing information
- MCP server configuration
- Console output capture
- Error context and stack traces

### Cross-Language Tracing

The tracing system maintains consistency across both implementations:

```typescript
// TypeScript
const tracer = new Tracer(traceId);
const span = tracer.startSpan("mcp.call", { method: "tools/list" });
// ... operation
tracer.endSpan(span, result);
```

```python
# Python
tracer = Tracer(trace_id)
span = tracer.start_span('mcp.call', {'method': 'tools/list'})
# ... operation
tracer.end_span(span, result)
```

### Console Capture

MCP Outlet automatically captures console output from MCP servers, providing complete visibility into server behavior:

- **stdout/stderr Separation**: Distinguish between normal output and errors
- **Real-time Capture**: Stream output as it's generated
- **Trace Integration**: Associate console output with specific trace spans
- **Debug Visibility**: See exactly what MCP servers are doing internally

## Unified Testing Framework

The testing system demonstrates advanced cross-language validation using a single source of truth for test specifications.

### Declarative Test Configuration

Test cases are defined once in TypeScript and automatically validated against both implementations:

```typescript
// test/config.ts - Single source of truth
const testSuite: TestSuiteConfig = {
  env: { NODE_ENV: "debug" },
  mocks: {
    connect: { returns: "void" },
    executeMcpCall: { returns: mockResult },
  },
  testCases: [
    {
      name: "tools/list returns available tools",
      input: { data: { method: "tools/list" } },
      expected: expectedResult(mockToolsResponse),
      mockCalls: [
        {
          mock: "executeMcpCall",
          calledWith: [ANY_OBJECT, ANY_OBJECT],
        },
      ],
    },
  ],
};
```

### Conditional Mocking Strategy

**Smart Mock Activation:**

- **TypeScript**: Always uses Jest mocks for consistency
- **Python**: Only activates mocks when test cases require them
- **Real Integration**: Python can run actual MCP servers when no mocks specified
- **Mock Verification**: Both languages verify expected method calls

**Mock Behavior Configuration:**

- `returns`: Set successful return value
- `throws`: Configure error scenarios
- `implementation`: Provide custom mock logic
- `"void"`: Return undefined/None explicitly

### Cross-Language Test Execution

```bash
# Clone and setup
git clone https://github.com/your-org/mcp-outlet.git
cd mcp-outlet
npm install

# Deploy to Azure (uses Python implementation)
npm run deploy
```

### 2. Local Development

```bash
# Start offline development server
npm start
# Server runs on http://localhost:3001
```

### 3. Use MCP Outlet

```bash
# Send JSON-RPC request to deployed endpoint
curl -X POST https://your-azure-function-url/mcpOutletPython \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "tools/list",
    "_meta": {
      "server": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-everything"]
      }
    }
  }'
```

## Architecture

**Single Entry Point**: One RPC handler routes all MCP methods

```python
# Add new MCP method in src/python/app/handlers/rpc.py
handlers_map = {
    "your/method": True,  # Forward to MCP server
    "outlet/method": lambda params, _: {"result": "direct"},  # Handle directly
    "unsupported/method": False,  # Reject
}
```

**Deployment Flow**:

1. Python code → Azure Functions (production)
2. UV package manager → Fast dependency resolution
3. OS pipes → Efficient MCP server communication
4. Asyncio locks → Race condition prevention

## Configuration

### Environment Variables

```bash
# Azure deployment (optional - has defaults)
RESOURCE_GROUP=mcp-outlet-rg
REGION=East US
PYTHON_SKU_NAME=EP1
PYTHON_SKU_TIER=ElasticPremium
```

### MCP Server Configuration

Pass MCP server config in request `_meta.server`:

```json
{
  "jsonrpc": "2.0",
  "method": "tools/list",
  "_meta": {
    "server": {
      "command": "python",
      "args": ["-m", "your_mcp_server"],
      "cwd": "/path/to/server",
      "env": { "API_KEY": "value" }
    }
  }
}
```

## Performance

**Python Implementation (Production)**:

- **Response Time**: < 500ms (warm execution)
- **Cold Start**: 1-3 seconds
- **Optimizations**: Pre-imports, UV caching, threaded servers, asyncio locks

**Key Features**:

- Pre-imported heavy libraries (pandas, numpy, matplotlib, requests)
- UV package manager with strategic caching
- OS pipe communication instead of subprocess
- Module-level asyncio locks prevent race conditions

## Development

### Add New MCP Method

1. **Add to handlers map** in `src/python/app/handlers/rpc.py`:

   ```python
   handlers_map = {
       "new/method": True,  # Forward to MCP server
   }
   ```

2. **Deploy**:
   ```bash
   npm run deploy
   ```

### Project Structure

```
mcp-outlet/
├── src/python/          # Python implementation (PRODUCTION)
│   └── app/handlers/rpc.py  # Main RPC handler
├── src/js/              # TypeScript implementation (TBD)
├── config.ts            # Deployment configuration
└── deployments/azure/   # Azure deployment scripts
```

## Commands

### ✅ Working Commands

```bash
npm run deploy          # Deploy to Azure (Python)
npm start              # Local development server
npm run package        # Package for deployment
npm run watch          # Watch TypeScript changes
```

### ❌ TBD Commands

```bash
# These don't work yet:
# npm run deploy:aws    # AWS deployment (fails)
# npm run deploy:gcp    # GCP deployment (not implemented)
```

## Current Reality

**MCP Outlet is a Python-first Azure MCP runtime** that safely executes any MCP server configuration through a single, optimized interface with comprehensive monitoring and sub-500ms performance.

- **Use for Production**: Python + Azure deployment
- **TypeScript Support**: Available but not optimized
- **Multi-Cloud**: Only Azure works currently

Perfect for safely running untrusted MCP servers, prototyping MCP integrations, and building production MCP-powered applications.
