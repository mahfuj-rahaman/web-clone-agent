# CLAUDE.md

Project-specific instructions for Claude Code in this repo. See `AGENTS.md` for the general agent-facing overview (architecture, source map, conventions) — read that first; this file only adds Claude-specific notes.

## Running things

```bash
npm run server   # REST API + GUI, http://localhost:3000
npm run cli -- <command>   # clone|list|read|delete|zip
npm run mcp      # MCP stdio server (used by Claude Desktop, not for manual runs)
```

No build step, no lint/test scripts defined in `package.json` — don't invent CI steps that don't exist.

## When editing

- Single source of truth for clone behavior is `src/core/cloner.js`. Prefer editing there over duplicating logic in `server.js`, `cli.js`, or `mcp-server.js`.
- This repo is not a git repository (no `.git` at `D:/ai/web-clone-agent`) — don't attempt git operations here unless the user initializes one first.
- `clones/` is generated output; never hand-edit files inside it, and don't include it in documentation as "source code."
- Match the existing style: plain Node `http` (no Express), ESM imports, no TypeScript, minimal dependencies (`jszip`, `zod`, `dotenv`, `@modelcontextprotocol/sdk`). Don't introduce a framework or new heavy dependency without asking.

## MCP server context

`claude_desktop_config.json` registers this project's MCP server via `docker exec -i web-clone-agent node src/mcp/mcp-server.js`, meaning it expects the Docker container from `docker-compose.yml` already running. If asked to test the MCP server locally without Docker, use `npm run mcp` directly instead and adjust expectations accordingly.
