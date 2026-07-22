#!/bin/sh
set -e

Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp &
XVFB_PID=$!

# Wait for Xvfb's lock file instead of relying on xvfb-run's SIGUSR1
# handshake, which is unreliable when this script runs as container PID 1.
for i in $(seq 1 50); do
    [ -e /tmp/.X99-lock ] && break
    sleep 0.1
done

export DISPLAY=:99
trap 'kill $XVFB_PID 2>/dev/null' EXIT

exec python camoufox_server.py
