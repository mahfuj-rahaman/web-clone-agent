# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this project is

A Node.js (ESM, `"type": "module"`) website-cloning tool with four interfaces — CLI, REST API, MCP server, browser GUI — all sharing one engine, `src/core/cloner.js`. No test suite, no build step, no framework (plain Node `http` for the server).

## Source map

- `src/core/cloner.js` — the engine. `clonePage()`, `listClones()`, `readCloneFile()`, `deleteClone()`, `getCloneZip()`. Any behavior change to cloning belongs here; the other three interfaces are thin wrappers.
- `src/core/renderer.js` — connects to a Camoufox server sidecar (via `playwright-core`'s cross-language websocket protocol, `firefox.connect()`) to fully render JS-heavy pages before `clonePage()` processes the HTML. Falls back to the plain HTTP fetch in `cloner.js` on any failure unless `RENDER_MODE=always`.
- `src/server/server.js` — REST API + static file host for `src/public/`.
- `src/cli/cli.js` — argv-parsed CLI, always emits JSON.
- `src/mcp/mcp-server.js` — MCP stdio tool server for AI agents.
- `src/public/index.html` — browser GUI, calls the REST API at same origin.
- `clones/` — runtime output directory, one subfolder per clone (`<hostname>_<ISO-timestamp>/`). Treat as generated data, not source.

## Conventions

- When changing cloning behavior (image handling, HTML cleanup, CSS inlining), edit `cloner.js` only — CLI/API/MCP/GUI all call through it, so a fix there fixes everywhere.
- CLI output must stay valid JSON (it's designed for agent/script consumption, not humans).
- Config lives in `.env` / `.env.example`, read via `CONFIG` in `cloner.js`. Don't hardcode ports, timeouts, or paths.
- No test suite currently exists. If you add one, wire it into `package.json` scripts.
- Keep new REST endpoints and MCP tools symmetric where it makes sense (e.g., if you add a capability to `cloner.js`, consider exposing it in both the REST API and MCP server).

## Known gaps / things to be careful about

- CLI's `--output <dir>` flag is parsed but **not wired into `clonePage()` options** — don't assume it works; either wire it up or don't rely on it.
- No auth on the REST API or CORS restriction (`Access-Control-Allow-Origin: *`) — fine for local/single-user use, not for exposing publicly without adding auth.
- Image downloading is regex-based extraction by file extension, not a full DOM parse — edge cases (encoded URLs, unusual markup) can be missed.
- `clones/` has no cleanup/retention policy — grows unbounded unless deleted via API/CLI.

## Camoufox rendering sidecar

- `docker-compose.yml` runs a `camoufox` service (`Dockerfile.camoufox`, Python + `camoufox` server mode) alongside `web-clone-agent`. `CAMOUFOX_WS_ENDPOINT` (default `ws://camoufox:9222`) points at it.
- `RENDER_MODE` controls behavior: `auto` (default, falls back to plain HTTP fetch if Camoufox is down), `always` (fails the clone instead of silently degrading), `never` (skip rendering, old plain-fetch-only behavior).
- Running `npm run server` locally (no Docker) needs Camoufox reachable separately: `pip install camoufox[geoip] && python -m camoufox fetch`, then run `python camoufox_server.py` (the plain `camoufox server` CLI takes no `--port`/`--host` flags, so this repo's `camoufox_server.py` calls `launch_server()` directly with a fixed port and `ws_path="camoufox"`). Set `CAMOUFOX_WS_ENDPOINT=ws://localhost:9222/camoufox` in `.env`.
- `playwright-core`'s version in `package.json` must match the Playwright server version bundled inside whatever `camoufox[geoip]` resolves to at install time (check `docker logs <camoufox container>` — it prints a version-mismatch banner naming both versions on a `browserType.connect()` failure). Currently pinned to `1.60.0`.
- Camoufox deliberately avoids true headless mode (it's a stealth/anti-detection signal), so both the Docker sidecar (`Dockerfile.camoufox` + `entrypoint.sh`) and any local run need a virtual X display (Xvfb) and Firefox's sandbox needs a permissive seccomp profile in Docker (`security_opt: seccomp:unconfined` in `docker-compose.yml`) — see `entrypoint.sh` for why it starts `Xvfb` directly rather than via `xvfb-run` (that wrapper's SIGUSR1 readiness handshake is unreliable as container PID 1).
- `metadata.rendered` on each clone records whether the fully-rendered path was actually used for that clone.

### Capturing dynamic/JS-revealed content (`renderPage()` in `renderer.js`)

Before capturing `page.content()`, the renderer runs three passes to pull JS-revealed content into the static snapshot, since `removeScripts` permanently deletes whatever JS would have revealed it interactively:
1. **`autoScroll`** — scrolls top-to-bottom in viewport steps so IntersectionObserver-driven reveal animations and lazy-loaded sections fire before capture (their pre-reveal state is often `opacity:0`, invisible forever without this).
2. **`expandCollapsedContent`** — opens native `<details>` and clicks common accordion/FAQ/collapse toggles (`aria-expanded="false"`, `[data-bs-toggle="collapse"]`, `.accordion-header`, etc.), skipping anything matching `UNSAFE_CLICK_KEYWORDS` (buy/checkout/delete/submit/...) or real navigation (`<a href>` that isn't `#`, `type="submit"`).
3. **`hoverSweep`** — hovers likely dropdown/submenu triggers (`HOVER_TARGET_SELECTOR`) one at a time; if the hover changed the element's class/style (how JS usually marks something "open"), that state is re-applied permanently and the element is swapped for a `cloneNode(true)` of itself so a *later* target's hover can't trigger this one's `mouseleave` handler and revert it before the final capture.

**Known ceiling, by design, not a bug to "fix":** a static HTML clone is one snapshot; it can't hold multiple *mutually exclusive* interactive states (tab A open vs. tab B open, one accordion item vs. another) simultaneously — the sweep just picks whichever one clicking/hovering first produced. Also out of scope for this snapshot-based approach: true SPA client-side routing (multiple logical "pages" behind one JS app), infinite-scroll pagination past what a few scroll passes surface, modal-only or login-gated content, and per-user personalized content. A future version wanting those would need a *multi-snapshot* crawl (distinct routes/states each saved as their own page) rather than one `index.html`.
- CSS-only `:hover` (dropdowns/tooltips with no JS involved) already works with zero help — the clone keeps the original CSS, so real mouse hover on the saved page behaves like the live site.

## Verifying changes

There's no automated test suite, so verify manually:
```bash
npm run server &
npm run cli -- clone https://example.com
npm run cli -- list
```
Check the resulting `clones/<id>/index.html` opens correctly offline (relative image paths resolve, no broken script tags if `removeScripts` was set).
