"""
Launches a Camoufox Playwright server bound to a fixed host/port so the
Node.js web-clone-agent container can connect via a stable ws:// endpoint.
The `camoufox server` CLI takes no options, so we call the underlying
`launch_server()` directly with the extra kwargs it passes through to
Playwright's `firefox.launchServer()`.
"""
from camoufox.server import launch_server

# ws_path pins the endpoint path (otherwise Playwright appends a random
# per-launch token, which the Node client can't predict from a fixed env var).
launch_server(headless=False, port=9222, host="0.0.0.0", ws_path="camoufox")
