# MCP Outlet

Universal runtime & proxy for Model-Context-Protocol (MCP) servers.

MCP Outlet lets you **run any MCP-compatible server in a secure, serverless sandbox**. It forwards JSON-RPC requests, adds tracing, and cleans up resources — no custom deployment per server required.

---

## Table of Contents

1. [Features](#features)
2. [Quick Start](#quick-start)
3. [Usage](#usage)
4. [Project Structure](#project-structure)
5. [Development](#development)
6. [Contributing](#contributing)
7. [License](#license)

---

## Features

- ⚡ **Production-ready Python runtime** – sub-500 ms warm latency (Azure Functions)
- ☁️ **One-command deployment** – `npm run deploy` pushes to Azure
- 🔌 **Plug-and-play** – forward any MCP method (`tools/*`, `prompts/*`, …)
- 🔍 **End-to-end tracing** – hierarchical spans, stdout/stderr capture
- 🛡️ **Isolation layer** – safely run untrusted or experimental MCP servers
- 🧰 **Unified schemas & tests** – Zod (TS) ↔︎ Pydantic (Py), shared test config

> TypeScript implementation is available but not optimized; Python is the default runtime.

---

## Quick Start

```bash
# 1. Clone & install JS dependencies
$ git clone https://github.com/<your-org>/mcp-outlet.git && cd mcp-outlet
$ npm install

# 2. Deploy the production-ready Python function to Azure (default)
$ npm run deploy
```

Need an Azure subscription? See `/docs/DEVELOPMENT.md` for details.

---

## Usage

Send JSON-RPC 2.0 requests to your deployed function (or local dev server):

```bash
curl -X POST https://<function-url>/mcpOutletPython \
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

For local development:

```bash
$ npm start        # local server on http://localhost:3001
```

---

## Project Structure

```
├── src/
│   ├── python/           # Production runtime (Async, Pydantic, UV)
│   └── js/               # Reference TypeScript implementation
├── deployments/          # Multi-cloud deploy helpers (Azure ready)
├── test/                 # Shared test configuration & helpers
└── config.ts             # Deployment manifest
```

See the [architecture docs](./docs/ARCHITECTURE.md) for a deeper dive.

---

## Development

```bash
# Watch TypeScript sources (optional)
$ npm run watch

# Run tests (JS + Python)
$ npm test            # generates config, runs both suites, cleans up
```

Python runtime specifics live in `src/python/app/handlers/`.  
Key entry point: `rpc.py`.

---

## Contributing

Issues and pull requests are welcome! If you add a new MCP method:

1. Update the `handlers_map` in `src/python/app/handlers/rpc.py`.
2. (Optional) Mirror the change in `src/js/handlers/rpc.ts`.
3. Add/extend test cases in `test/config.ts` (shared for both langs).

Please follow the existing code style (Black + Ruff for Python, Prettier + ESLint for TS).

---

## License

This project is released under the Apache License. See [LICENSE](LICENSE) for details.
