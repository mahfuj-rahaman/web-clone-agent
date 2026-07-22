# Web Clone Agent

AI-first website cloning tool. Give it a URL, it fetches the page server-side (no CORS issues), inlines CSS, downloads images, strips scripts (optional), and saves a self-contained, offline-browsable copy to disk — accessible via CLI, REST API, MCP (for AI agents like Claude Desktop), or a browser GUI.

## Interfaces

| Interface | Entry point | Use case |
|---|---|---|
| CLI | `npm run cli -- <command>` | Scripting, terminal use, JSON output |
| REST API | `npm run server` → `http://localhost:3000` | Programmatic access, the browser GUI |
| MCP server | `npm run mcp` | AI agents (Claude Desktop, etc.) via stdio |
| Browser GUI | `src/public/index.html`, served by the REST server | Manual point-and-click use |

All four share one engine: `src/core/cloner.js`.

## Quick start

```bash
npm install
cp .env.example .env
npm run server        # REST API + GUI at http://localhost:3000
```

```bash
npm run cli -- clone https://example.com
npm run cli -- list
npm run cli -- read <cloneId> index.html
npm run cli -- zip <cloneId>
npm run cli -- delete <cloneId>
```

## How a clone is built

1. Fetch the page HTML server-side.
2. Inline `<link rel="stylesheet">` CSS into `<style>` tags (fixing `url()` references).
3. Resolve relative `src`/`href`/`data-src`/`poster`/`srcset` to absolute URLs.
4. Download images (extension-filtered, size-capped), saved under their original URL path for SEO-friendliness; HTML rewritten to relative local paths.
5. Strip `<script>` tags and inline event handlers (if `removeScripts` is true).
6. Clean up cruft: `<base>`, preload/prefetch links, lazy-loading attrs, `<noscript>`, meta-refresh, unreachable external stylesheets.
7. Extract the page title.
8. Write everything to `clones/<hostname>_<ISO-timestamp>/`.
9. Optionally bundle a ZIP (JSZip).

Output layout:
```
clones/<hostname>_<timestamp>/
  index.html       # self-contained, offline-ready
  metadata.json    # id, url, hostname, clonedAt, options, file list
  images/...        # mirrors original URL path structure
```

## REST API

See `REST API.md` for curl examples. Summary:

- `POST /api/clone` — `{ url, includeImages?, removeScripts?, createZip? }`
- `GET /api/clones` — list all clones
- `GET /api/clones/:id` — single clone metadata
- `GET /api/clones/:id/file?path=...` — read a file's content
- `GET /api/clones/:id/zip` — download as ZIP
- `DELETE /api/clones/:id` — delete a clone
- `GET /api/config` — default config for the frontend

## MCP server (for AI agents)

Exposes `clone_page`, `list_clones`, `read_clone_file`, `delete_clone` as MCP tools over stdio. See `claude_desktop_config.json` for an example client config (assumes the app is running via Docker: `docker exec -i web-clone-agent node src/mcp/mcp-server.js`).

## Configuration

Set via `.env` (see `.env.example`):

| Var | Purpose |
|---|---|
| `PORT` | REST server port (default 3000) |
| `PROXY_TIMEOUT` | Fetch timeout (ms) |
| `USER_AGENT` | UA string sent when fetching pages |
| `ENABLE_LOGGING` | Toggle log output |
| `CLONES_DIR` | Where clones are stored |
| `DEFAULT_INCLUDE_IMAGES` / `DEFAULT_REMOVE_SCRIPTS` | Default clone options |
| `MAX_IMAGE_SIZE_BYTES` | Per-image size cap (0 = unlimited) |
| `INCLUDED_IMAGE_EXTENSIONS` | Comma list of extensions to download |
| `MCP_SERVER_NAME` / `MCP_SERVER_VERSION` | MCP server identity |

## Docker

```bash
docker-compose up -d
```

Runs the REST server by default (`node src/server/server.js`), mounts `./clones` for persistence. CLI/MCP run inside the same container via `docker exec`.

## Project structure

```
src/
  core/cloner.js     # shared engine (fetch, inline CSS, images, cleanup, save/zip)
  server/server.js   # REST API + static GUI host
  cli/cli.js         # CLI wrapper, JSON output
  mcp/mcp-server.js  # MCP tool server (stdio)
  public/index.html  # browser GUI
clones/               # cloned output (gitignored, persisted via Docker volume)
```

See `AGENTS.md` / `CLAUDE.md` for guidance aimed at AI coding agents working in this repo.
