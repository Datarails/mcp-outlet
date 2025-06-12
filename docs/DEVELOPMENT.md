# MCP Outlet – Development Guide

This guide covers common development tasks for contributors.

---

## 1. Prerequisites

- Node.js ≥ 18
- Python 3.11
- Azure CLI (for deployment)
- `uv` (Python package manager) – will auto-install on first use

---

## 2. Install Dependencies

```bash
npm install            # JS/TS deps + Husky hooks
uv pip install -r src/python/requirements-dev.txt  # Python dev deps (ruff, black, pytest)
```

---

## 3. Run Locally

```bash
# Start the offline dev server (Express + Python function shim)
npm start
# → http://localhost:3001
```

Hot-reload is enabled for TypeScript sources via `npm run watch`.

---

## 4. Testing

```bash
npm test     # Generates test config, runs Jest + Pytest, cleans up
```

To run only the Python suite:

```bash
cd src/python && TEST_CONFIG_PATH=../../test/config.json PYTHONPATH=. uv run pytest
```

---

## 5. Lint & Format

```bash
# TypeScript
npm run lint           # ESLint
npm run format         # Prettier

# Python
uv run ruff check src/python
uv run ruff format src/python
uv run black src/python
```

---

## 6. Adding a New MCP Method

1. Edit `src/python/app/handlers/rpc.py` and update `handlers_map`.
2. (Optional) Update the TypeScript map in `src/js/handlers/rpc.ts`.
3. Add test cases in `test/config.ts`.
4. Run `npm test`.

---

## 7. Deployment

### Azure (production)

```bash
npm run deploy    # Bundles and pushes the Python function to Azure
```

### Offline Package

```bash
npm run package   # Creates .zip files in .mcp-outlet/
```

---

## 8. VS Code Recommendations

Install the following extensions:

- **Python**
- **Pylance**
- **ESLint**
- **Prettier**
- **Markdoc Markdown** (for docs)

Settings snippet:

```jsonc
{
  "python.formatting.provider": "black",
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "source.organizeImports": true,
    "source.fixAll": true
  }
}
```

---

## 9. FAQ

**Q: Why Python first?**  
A: Performance and easier Azure Functions cold-start optimisation. TS is provided for reference.

**Q: Can I deploy to AWS/GCP?**  
A: The framework exists, but those targets need work. Contributions welcome!

---

Happy hacking! 🎉
