# Web Clone Agent

AI-first website cloning tool. Give it a URL, it renders the page in a real (stealth) browser, inlines CSS, downloads images, strips scripts (optional), and saves a self-contained, offline-browsable copy to disk — accessible via CLI, REST API, MCP (for AI agents like Claude Desktop), or a browser GUI. Saved clones can be viewed instantly at `/preview/<cloneId>/` without leaving the app.

**License:** personal and non-profit use only — no commercial use. See [`LICENSE.md`](./LICENSE.md).

## Quick start (Docker — nothing else to install)

Everything runs inside Docker. You don't need Node, Python, or a browser installed on the host — `docker compose` builds both the app and its Camoufox rendering sidecar for you.

```bash
git clone https://github.com/mahfuj-rahaman/web-clone-agent.git
cd web-clone-agent
cp .env.example .env
docker compose up -d --build
```

Then open **http://localhost:3400** (or whatever `PORT` you set in `.env`).

```bash
# CLI, run inside the same container:
docker exec -it web-clone-agent node src/cli/cli.js clone https://example.com
docker exec -it web-clone-agent node src/cli/cli.js list
```

`docker compose` starts two containers:

| Service | What it is | Why |
|---|---|---|
| `web-clone-agent` | The Node.js app (REST API + GUI + CLI + MCP) | Does the actual cloning |
| `camoufox` | A [Camoufox](https://camoufox.com) (hardened/stealth Firefox) server, headless-in-a-virtual-display | Renders JS-heavy pages so the clone captures what a real visitor sees, not just the raw server response |

Clones persist in `./clones` on the host (Docker volume), so they survive container rebuilds.

### Running without Docker (not the primary path)

Only do this if you specifically need to run the Node process directly on the host. You'd have to separately stand up Camoufox (`pip install camoufox[geoip] && python -m camoufox fetch && python camoufox_server.py`) and point `CAMOUFOX_WS_ENDPOINT` at it — see `AGENTS.md` for the full local (non-Docker) setup. This is more setup, not less; Docker is the supported path.

## Interfaces

| Interface | Entry point | Use case |
|---|---|---|
| REST API | `http://localhost:3400/api/...` | Programmatic access, the browser GUI |
| Browser GUI | `http://localhost:3400/` | Manual point-and-click use, includes a live **Preview** link per saved clone |
| CLI | `docker exec -it web-clone-agent node src/cli/cli.js <command>` | Scripting, terminal use, JSON output |
| MCP server | `docker exec -i web-clone-agent node src/mcp/mcp-server.js` | AI agents (Claude Desktop, etc.) via stdio |

All four share one engine: `src/core/cloner.js`.

## How a clone is built

1. **Render the page.** By default (`renderMode: "auto"`), Camoufox loads the page in a real browser tab — this gets past sites that block plain HTTP requests (hotlink/bot protection), and executes the page's own JS. Falls back to a plain HTTP fetch if Camoufox is unreachable (or `renderMode: "never"` skips rendering entirely).
2. **Surface JS-revealed content before it's stripped.** Since scripts get removed later, the renderer first: scrolls top-to-bottom (triggers scroll-reveal animations/lazy sections), opens `<details>` and safe accordion/FAQ toggles, and hovers likely dropdown/submenu triggers (freezing whatever they reveal). See `AGENTS.md` for exactly what this can and can't capture — a static clone is one snapshot, so mutually-exclusive UI states (tab A vs. tab B) aren't all preserved.
3. Inline `<link rel="stylesheet">` CSS into `<style>` tags (fixing `url()` references).
4. Resolve relative `src`/`href`/`data-src`/`poster`/`srcset` **against the page's actual base** (respecting a `<base href>` tag if present, not just the request URL) to absolute URLs.
5. Download images (extension-filtered, size-capped) — through the same rendered-page browser session when available, so sites that block plain server-side requests still work. Failed downloads (404s, oversized) get a local placeholder SVG instead of either a corrupted fake file or a dangling link to the original (broken) live URL.
6. Strip `<script>` tags and inline event handlers (if `removeScripts` is true).
7. Clean up cruft: preload/prefetch links, lazy-loading attrs, `<noscript>`, meta-refresh, unreachable external stylesheets.
8. Extract the page title.
9. Write everything to `clones/<hostname>_<ISO-timestamp>/`.
10. Optionally bundle a ZIP (JSZip).

Output layout:
```
clones/<hostname>_<timestamp>/
  index.html            # self-contained, offline-ready
  metadata.json         # id, url, hostname, clonedAt, options, rendered flag, file list
  _broken-image.svg     # only present if at least one image failed to download
  <original-path>/...   # images, mirroring the site's own URL path structure
```

## Previewing a saved clone

Every clone can be opened directly, served from its own saved files:

```
http://localhost:3400/preview/<cloneId>/
```

The GUI's "Saved Clones" list has a **Preview** button/link for this. It's a plain static file server scoped to that one clone's directory — no re-fetching, no live network calls to the original site.

## REST API

See `REST API.md` for curl examples. Summary:

- `POST /api/clone` — `{ url, includeImages?, removeScripts?, createZip?, renderMode? }` (`renderMode`: `"auto"` | `"always"` | `"never"`)
- `GET /api/clones` — list all clones
- `GET /api/clones/:id` — single clone metadata
- `GET /api/clones/:id/file?path=...` — read a file's content
- `GET /api/clones/:id/zip` — download as ZIP
- `DELETE /api/clones/:id` — delete a clone
- `GET /api/config` — default config for the frontend (includes `defaultRenderMode`)
- `GET /preview/:id/*` — serve a saved clone's own files (see above)

## MCP server (for AI agents)

Exposes `clone_page` (accepts an optional `renderMode`), `list_clones`, `read_clone_file`, `delete_clone` as MCP tools over stdio. See `claude_desktop_config.json` for an example client config — it runs the server via `docker exec -i web-clone-agent node src/mcp/mcp-server.js`, so it expects the Docker stack already running (`docker compose up -d`).

## Configuration

Set via `.env` (see `.env.example`):

| Var | Purpose |
|---|---|
| `PORT` | REST server port (default 3400) |
| `PROXY_TIMEOUT` | Plain-HTTP fetch timeout (ms) |
| `USER_AGENT` | UA string sent when fetching pages without Camoufox |
| `ENABLE_LOGGING` | Toggle log output |
| `CLONES_DIR` | Where clones are stored |
| `DEFAULT_INCLUDE_IMAGES` / `DEFAULT_REMOVE_SCRIPTS` | Default clone options |
| `MAX_IMAGE_SIZE_BYTES` | Per-image size cap (0 = unlimited) |
| `INCLUDED_IMAGE_EXTENSIONS` | Comma list of extensions to download |
| `MCP_SERVER_NAME` / `MCP_SERVER_VERSION` | MCP server identity |
| `RENDER_MODE` | `auto` (default, falls back to plain fetch), `always` (fail if Camoufox is down), `never` (skip rendering) |
| `RENDER_TIMEOUT_MS` | Per-page render timeout budget |
| `CAMOUFOX_WS_ENDPOINT` | Websocket endpoint of the Camoufox server (default `ws://camoufox:9222/camoufox`, matching `docker-compose.yml`) |
| `API_KEY` | Optional; if set, `POST /api/clone` and `DELETE /api/clones/:id` require header `x-api-key: <value>` |
| `RATE_LIMIT_PER_MINUTE` | Max `POST /api/clone` requests per IP per minute |

## Docker

```bash
docker compose up -d --build   # first run / after any code or Dockerfile change
docker compose logs -f web-clone-agent
docker compose logs -f camoufox
docker compose down            # stop both containers
```

`docker-compose.yml` runs two services (see table above). `web-clone-agent` depends on `camoufox` and mounts `./clones` for persistence. The `camoufox` service needs `security_opt: seccomp:unconfined` (Firefox's sandbox requires user-namespace creation, which Docker's default seccomp profile blocks) and starts its own virtual X display — see `entrypoint.sh` and `AGENTS.md` for why.

CLI/MCP run inside the already-running `web-clone-agent` container via `docker exec`, not as separate containers.

## Project structure

```
src/
  core/cloner.js       # shared engine (render, inline CSS, images, cleanup, save/zip)
  core/renderer.js     # Camoufox connection + scroll/hover/accordion content-reveal sweeps
  server/server.js     # REST API + static GUI host + /preview static file server
  cli/cli.js           # CLI wrapper, JSON output
  mcp/mcp-server.js    # MCP tool server (stdio)
  public/index.html    # browser GUI (clone form + saved-clones list with Preview/ZIP/Del)
Dockerfile              # web-clone-agent image
Dockerfile.camoufox     # camoufox sidecar image
entrypoint.sh           # camoufox container entrypoint (starts Xvfb, then the server)
camoufox_server.py      # launches Camoufox's Playwright server on a fixed port/path
clones/                 # cloned output (gitignored, persisted via Docker volume)
```

See `AGENTS.md` / `CLAUDE.md` for guidance aimed at AI coding agents working in this repo — including the Camoufox setup details, the content-reveal sweeps' exact capabilities/limits, and known gaps.
